import { readFile } from 'node:fs/promises';

import { getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    type Base58EncodedBytes,
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    getSignatureFromTransaction,
    type Instruction,
    isSolanaError,
    type KeyPairSigner,
    pipe,
    type Signature,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    signature as toSignature,
} from '@solana/kit';
import {
    DELEGATEE_OFFSET,
    decodePlan,
    decodeSubscriptionDelegation,
    findEventAuthorityPda,
    findSubscriptionAuthorityPda,
    findSubscriptionDelegationPda,
    getTransferSubscriptionOverlayInstructionAsync,
    PLAN_SIZE,
    resolveTransferHookAccounts,
    SUBSCRIPTION_SIZE,
    SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
    SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
    SUBSCRIPTIONS_ERROR__INVALID_DELEGATE_PDA,
    SUBSCRIPTIONS_ERROR__PLAN_CLOSED,
    SUBSCRIPTIONS_ERROR__PLAN_EXPIRED,
    SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
    SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    toEncodedAccount,
    type RawProgramAccount,
} from '@solana/subscriptions';

import type { FailureReason } from '../core/billing.js';
import { extractEvents, type JsonTransaction, type ProgramEvent } from './events.js';
import {
    type Chain,
    ChargeError,
    type ChainPlan,
    type ChainSubscription,
    type ChargeRequest,
    type SignatureInfo,
    type SignatureOutcome,
    type SourceAccountState,
} from './types.js';

// SPL Token / Token-2022 custom error codes (shared numbering).
const TOKEN_ERROR_INSUFFICIENT_FUNDS = 1;
const TOKEN_ERROR_OWNER_MISMATCH = 4;

export interface SolanaChainOptions {
    rpcUrl: string;
    wsUrl: string;
    programAddress?: Address;
    signer?: KeyPairSigner;
    /** Priority fee in micro-lamports per compute unit. 0 = none. */
    computeUnitPriceMicroLamports?: bigint;
    /** Commitment for event ingestion. 'finalized' (default) never sees a rolled-back fork. */
    ingestCommitment?: 'confirmed' | 'finalized';
}

export async function loadKeypairFile(path: string): Promise<KeyPairSigner> {
    const bytes = JSON.parse(await readFile(path, 'utf8')) as number[];
    return createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}

type ParsedTokenAccount = {
    parsed: {
        info: {
            mint: string;
            owner: string;
            tokenAmount: { amount: string };
            delegate?: string;
            delegatedAmount?: { amount: string };
        };
    };
};

export class SolanaChain implements Chain {
    private readonly rpc;
    private readonly sendAndConfirm;
    readonly programAddress: Address;
    private eventAuthority: Promise<Address> | null = null;
    private readonly tokenProgramCache = new Map<string, Address>();

    constructor(private readonly opts: SolanaChainOptions) {
        this.rpc = createSolanaRpc(opts.rpcUrl);
        const rpcSubscriptions = createSolanaRpcSubscriptions(opts.wsUrl);
        this.sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: this.rpc, rpcSubscriptions });
        this.programAddress = opts.programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS;
    }

    get signerAddress(): string | null {
        return this.opts.signer?.address ?? null;
    }

    async clusterTime(): Promise<bigint> {
        const slot = await this.rpc.getSlot({ commitment: 'confirmed' }).send();
        const t = await this.rpc.getBlockTime(slot).send();
        return t === null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(t);
    }

    async signaturePage(
        addr: string,
        opts: { before?: string; until?: string; limit: number },
    ): Promise<SignatureInfo[]> {
        const page = await withRetry(() =>
            this.rpc
                .getSignaturesForAddress(address(addr), {
                    commitment: this.opts.ingestCommitment ?? 'finalized',
                    limit: opts.limit,
                    before: opts.before ? toSignature(opts.before) : undefined,
                    until: opts.until ? toSignature(opts.until) : undefined,
                })
                .send(),
        );
        return page.map(s => ({
            signature: s.signature,
            slot: BigInt(s.slot),
            blockTime: s.blockTime === null ? null : BigInt(s.blockTime),
            failed: s.err !== null,
        }));
    }

    async subscriptionAddress(plan: string, subscriber: string): Promise<string> {
        const [pda] = await findSubscriptionDelegationPda(
            { planPda: address(plan), subscriber: address(subscriber) },
            { programAddress: this.programAddress },
        );
        return pda;
    }

    async transactionEvents(sig: string): Promise<ProgramEvent[] | null> {
        this.eventAuthority ??= findEventAuthorityPda({ programAddress: this.programAddress }).then(([pda]) => pda);
        const tx = await withRetry(() =>
            this.rpc
                .getTransaction(toSignature(sig), {
                    commitment: this.opts.ingestCommitment ?? 'finalized',
                    encoding: 'json',
                    maxSupportedTransactionVersion: 0,
                })
                .send(),
        );
        if (!tx) return null;
        return extractEvents(tx as unknown as JsonTransaction, this.programAddress, await this.eventAuthority);
    }

    async fetchAllPlans(): Promise<ChainPlan[]> {
        const accounts = await withRetry(() =>
            this.rpc
                .getProgramAccounts(this.programAddress, {
                    encoding: 'base64',
                    filters: [{ dataSize: BigInt(PLAN_SIZE) }],
                })
                .send(),
        );
        return accounts.map(raw => {
            const { address: addr, data } = decodePlan(
                toEncodedAccount(raw as unknown as RawProgramAccount, this.programAddress),
            );
            return {
                address: addr,
                owner: data.owner,
                planId: data.data.planId,
                mint: data.data.mint,
                amount: data.data.terms.amount,
                periodHours: data.data.terms.periodHours,
                termsCreatedAt: data.data.terms.createdAt,
                endTs: data.data.endTs,
                status: data.status,
                destinations: data.data.destinations.filter(isNonZero),
                pullers: data.data.pullers.filter(isNonZero),
                metadataUri: data.data.metadataUri.replace(/\0+$/, ''),
            };
        });
    }

    async fetchSubscriptions(plans: string[]): Promise<Map<string, ChainSubscription[]>> {
        const byPlan = new Map<string, ChainSubscription[]>(plans.map(p => [p, []]));
        // A few plans: one filtered query each. Many plans: one query for everything, grouped locally.
        const batches =
            plans.length <= PER_PLAN_QUERY_LIMIT ? plans.map(p => this.querySubscriptions(p)) : [this.querySubscriptions()];
        for (const subs of await Promise.all(batches)) {
            for (const s of subs) byPlan.get(s.plan)?.push(s);
        }
        return byPlan;
    }

    private async querySubscriptions(plan?: string): Promise<ChainSubscription[]> {
        const filters = [
            { dataSize: BigInt(SUBSCRIPTION_SIZE) },
            ...(plan
                ? [
                      {
                          memcmp: {
                              offset: BigInt(DELEGATEE_OFFSET),
                              bytes: plan as Base58EncodedBytes,
                              encoding: 'base58' as const,
                          },
                      },
                  ]
                : []),
        ];
        const accounts = await withRetry(() =>
            this.rpc.getProgramAccounts(this.programAddress, { encoding: 'base64', filters }).send(),
        );
        return accounts.map(raw => {
            const { address: addr, data } = decodeSubscriptionDelegation(
                toEncodedAccount(raw as unknown as RawProgramAccount, this.programAddress),
            );
            return {
                address: addr,
                plan: data.header.delegatee,
                subscriber: data.header.delegator,
                payer: data.header.payer,
                amount: data.terms.amount,
                periodHours: data.terms.periodHours,
                termsCreatedAt: data.terms.createdAt,
                amountPulledInPeriod: data.amountPulledInPeriod,
                currentPeriodStartTs: data.currentPeriodStartTs,
                expiresAtTs: data.expiresAtTs,
            };
        });
    }

    async subscriptionAuthorityAddress(subscriber: string, mint: string): Promise<string> {
        const [pda] = await findSubscriptionAuthorityPda(
            { user: address(subscriber), tokenMint: address(mint) },
            { programAddress: this.programAddress },
        );
        return pda;
    }

    private async tokenProgramFor(mint: string): Promise<Address> {
        const cached = this.tokenProgramCache.get(mint);
        if (cached) return cached;
        const info = await this.rpc.getAccountInfo(address(mint), { encoding: 'base64' }).send();
        if (!info.value) throw new ChargeError('program_error', `mint ${mint} not found`);
        this.tokenProgramCache.set(mint, info.value.owner);
        return info.value.owner;
    }

    private async ata(owner: string, mint: string): Promise<Address> {
        const tokenProgram = await this.tokenProgramFor(mint);
        const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram });
        return ata;
    }

    async sourceAccountState(subscriber: string, mint: string): Promise<SourceAccountState> {
        const ata = await this.ata(subscriber, mint);
        const res = await this.rpc.getAccountInfo(ata, { encoding: 'jsonParsed' }).send();
        const data = res.value?.data as ParsedTokenAccount | undefined;
        if (!data?.parsed?.info) return { exists: false, amount: 0n, delegate: null, delegatedAmount: 0n };
        const info = data.parsed.info;
        return {
            exists: true,
            amount: BigInt(info.tokenAmount.amount),
            delegate: info.delegate ?? null,
            delegatedAmount: BigInt(info.delegatedAmount?.amount ?? '0'),
        };
    }

    async charge(req: ChargeRequest, onSigned: (signature: string) => Promise<void>): Promise<string> {
        const signer = this.opts.signer;
        if (!signer) throw new Error('charge() called without a signer configured');

        const mint = address(req.plan.mint);
        const tokenProgram = await this.tokenProgramFor(req.plan.mint);
        const subscriber = address(req.subscription.subscriber);
        const destination = address(req.destinationOwner);
        const [receiverAta] = await findAssociatedTokenPda({ owner: destination, mint, tokenProgram });
        const [sourceAta] = await findAssociatedTokenPda({ owner: subscriber, mint, tokenProgram });
        const authority = address(await this.subscriptionAuthorityAddress(req.subscription.subscriber, req.plan.mint));

        const instructions: Instruction[] = [];
        if (this.opts.computeUnitPriceMicroLamports) {
            instructions.push(
                getSetComputeUnitPriceInstruction({ microLamports: this.opts.computeUnitPriceMicroLamports }),
            );
        }
        const receiverInfo = await this.rpc.getAccountInfo(receiverAta, { encoding: 'base64' }).send();
        if (!receiverInfo.value) {
            instructions.push(
                await getCreateAssociatedTokenIdempotentInstructionAsync({
                    payer: signer,
                    owner: destination,
                    mint,
                    tokenProgram,
                }),
            );
        }
        const transferHookAccounts = await resolveTransferHookAccounts(this.rpc, {
            amount: req.amount,
            authority,
            destination: receiverAta,
            mint,
            source: sourceAta,
            tokenProgram,
        });
        instructions.push(
            await getTransferSubscriptionOverlayInstructionAsync({
                programAddress: this.programAddress,
                amount: req.amount,
                caller: signer,
                delegator: subscriber,
                planPda: address(req.plan.address),
                receiverAta,
                subscriptionPda: address(req.subscription.address),
                tokenMint: mint,
                tokenProgram,
                transferHookAccounts,
            }),
        );

        const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(signer, m),
            m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
            m => appendTransactionMessageInstructions(instructions, m),
        );
        const tx = await signTransactionMessageWithSigners(message);
        assertIsTransactionWithBlockhashLifetime(tx);
        const signature = getSignatureFromTransaction(tx);
        await onSigned(signature);

        try {
            await this.sendAndConfirm(tx, { commitment: 'confirmed' });
        } catch (err) {
            throw classifySendError(err, signature);
        }
        return signature;
    }

    async signatureOutcome(signature: string): Promise<SignatureOutcome> {
        const { value } = await this.rpc
            .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
            .send();
        const status = value[0];
        if (!status || (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')) {
            return { status: 'unknown' };
        }
        if (status.err) return { status: 'failed', error: JSON.stringify(status.err, bigintReplacer) };
        return { status: 'succeeded' };
    }
}

const PER_PLAN_QUERY_LIMIT = 5;

/** Retries a read on HTTP 429 / 5xx with exponential backoff. Never wrap sends in this. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            const retryable = /HTTP error \((429|5\d\d)\)/.test(msg);
            if (!retryable || i >= attempts - 1) throw err;
            await new Promise(r => setTimeout(r, 500 * 2 ** i));
        }
    }
}

function isNonZero(a: string): boolean {
    return a !== '11111111111111111111111111111111';
}

function bigintReplacer(_k: string, v: unknown) {
    return typeof v === 'bigint' ? v.toString() : v;
}

/** Finds the custom program error code anywhere in a SolanaError cause chain. */
function customErrorCode(err: unknown): number | null {
    let cur: unknown = err;
    for (let depth = 0; cur && depth < 8; depth++) {
        if (isSolanaError(cur, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return Number(cur.context.code);
        cur = (cur as { cause?: unknown }).cause;
    }
    return null;
}

const PROGRAM_ERROR_REASONS: Record<number, FailureReason> = {
    [SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED]: 'subscription_cancelled',
    [SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED]: 'plan_ended',
    [SUBSCRIPTIONS_ERROR__PLAN_EXPIRED]: 'plan_ended',
    [SUBSCRIPTIONS_ERROR__PLAN_CLOSED]: 'plan_ended',
    [SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY]: 'delegate_revoked',
    [SUBSCRIPTIONS_ERROR__INVALID_DELEGATE_PDA]: 'delegate_revoked',
    // Someone else (another puller) already collected this period; next sync will show it.
    [SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT]: 'program_error',
};

export function classifySendError(err: unknown, signature?: string): ChargeError {
    const message = err instanceof Error ? err.message : String(err);
    const code = customErrorCode(err);
    if (code === null) return new ChargeError('transient', message, signature);
    if (code === TOKEN_ERROR_INSUFFICIENT_FUNDS) return new ChargeError('insufficient_funds', message, signature);
    if (code === TOKEN_ERROR_OWNER_MISMATCH) return new ChargeError('delegate_revoked', message, signature);
    return new ChargeError(PROGRAM_ERROR_REASONS[code] ?? 'program_error', `program error ${code}: ${message}`, signature);
}
