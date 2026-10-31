/**
 * End-to-end against a running Surfpool (mainnet fork) with the real program and real USDC mint:
 *
 *   surfpool start --ci --no-tui --no-deploy --network mainnet
 *   SURFPOOL_URL=http://127.0.0.1:8899 pnpm test:e2e
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    generateKeyPairSigner,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import {
    fetchPlan,
    fetchSubscriptionAuthority,
    findPlanPda,
    findSubscriptionAuthorityPda,
    findSubscriptionDelegationPda,
    getCancelSubscriptionOverlayInstructionAsync,
    getCreatePlanOverlayInstructionAsync,
    getInitSubscriptionAuthorityOverlayInstructionAsync,
    getSubscribeOverlayInstructionAsync,
} from '@solana/subscriptions';
import pino from 'pino';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SolanaChain } from '../../src/chain/solana.js';
import { connectPglite, type Db, migrate } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { syncOnce } from '../../src/indexer/sync.js';
import { deliverDueEvents } from '../../src/webhooks/dispatcher.js';
import { generateSecret } from '../../src/webhooks/signature.js';
import { runChargeCycle, type WorkerConfig } from '../../src/worker/charge.js';

const URL = process.env.SURFPOOL_URL;
const RPC_URL = URL ?? 'http://127.0.0.1:8899';
// Surfpool serves WebSocket subscriptions on the RPC port + 1.
const WS_URL = (() => {
    const u = new globalThis.URL(RPC_URL.replace(/^http/, 'ws'));
    u.port = String(Number(u.port || 80) + 1);
    return u.toString();
})();
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PRICE = 1_000_000n; // 1 USDC per period
const PERIOD_HOURS = 1n;
const log = pino({ level: process.env.LOG_LEVEL ?? 'silent' });
const cfg: WorkerConfig = { retryScheduleSecs: [60], pendingTimeoutSecs: 180, maxChargesPerCycle: 50, dryRun: false };

describe.skipIf(!URL)('e2e on Surfpool', () => {
    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    let db: Db;
    let repo: Repo;
    let chain: SolanaChain;
    let merchant: KeyPairSigner;
    let puller: KeyPairSigner;
    let alice: KeyPairSigner;
    let bob: KeyPairSigner;
    let planPda: Address;
    const planId = BigInt(Date.now()); // unique per run against a long-lived surfnet

    async function cheat(method: string, params: unknown[]) {
        const res = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const body = (await res.json()) as { error?: unknown; result?: unknown };
        if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
        return body.result;
    }

    async function send(payer: KeyPairSigner, ixs: Instruction[]) {
        const { value: blockhash } = await rpc.getLatestBlockhash().send();
        const msg = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
            m => appendTransactionMessageInstructions(ixs, m),
        );
        const tx = await signTransactionMessageWithSigners(msg);
        assertIsTransactionWithBlockhashLifetime(tx);
        try {
            await sendAndConfirm(tx, { commitment: 'confirmed' });
        } catch (err) {
            const logs = (err as { cause?: { context?: { logs?: string[] } } }).cause?.context?.logs;
            const keys = ixs.map(ix => ix.accounts?.map(a => a.address).join(','));
            throw new Error(`send failed: ${String(err)}\naccounts: ${keys.join(' | ')}\nlogs: ${(logs ?? []).join('\n')}`, { cause: err });
        }
    }

    async function usdcBalance(owner: Address): Promise<bigint> {
        const [ata] = await findAssociatedTokenPda({ owner, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const info = await rpc.getAccountInfo(ata, { encoding: 'jsonParsed' }).send();
        const parsed = info.value?.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } } | undefined;
        return BigInt(parsed?.parsed?.info?.tokenAmount?.amount ?? '0');
    }

    async function timeTravelSecs(secs: bigint) {
        const now = await chain.clusterTime();
        await cheat('surfnet_timeTravel', [{ absoluteTimestamp: Number((now + secs) * 1000n) }]);
        // Let a block land so getBlockTime and the Clock sysvar reflect the jump.
        await new Promise(r => setTimeout(r, 1500));
    }

    async function subscribe(user: KeyPairSigner) {
        const [userAta] = await findAssociatedTokenPda({ owner: user.address, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        await send(user, [
            await getInitSubscriptionAuthorityOverlayInstructionAsync({
                owner: user,
                tokenMint: USDC,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
                userAta,
            }),
        ]);
        const [sa] = await findSubscriptionAuthorityPda({ user: user.address, tokenMint: USDC });
        const { data: authority } = await fetchSubscriptionAuthority(rpc, sa);
        const { data: plan } = await fetchPlan(rpc, planPda);
        await send(user, [
            await getSubscribeOverlayInstructionAsync({
                subscriber: user,
                merchant: merchant.address,
                planId,
                tokenMint: USDC,
                expectedAmount: plan.data.terms.amount,
                expectedPeriodHours: plan.data.terms.periodHours,
                expectedCreatedAt: plan.data.terms.createdAt,
                expectedSubscriptionAuthorityInitId: authority.initId,
            }),
        ]);
        const [sub] = await findSubscriptionDelegationPda({ planPda, subscriber: user.address });
        return sub;
    }

    const cycle = async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        return runChargeCycle({ repo, chain, cfg, log });
    };

    let aliceSub: Address;
    let bobSub: Address;

    beforeAll(async () => {
        [merchant, puller, alice, bob] = await Promise.all([
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
        ]);
        for (const k of [merchant, puller, alice, bob]) {
            await rpc.requestAirdrop(k.address, lamports(5_000_000_000n)).send();
        }
        for (const k of [merchant, puller, alice, bob]) {
            for (let i = 0; (await rpc.getBalance(k.address).send()).value === 0n; i++) {
                if (i > 50) throw new Error(`airdrop to ${k.address} never landed`);
                await new Promise(r => setTimeout(r, 200));
            }
        }
        await cheat('surfnet_setTokenAccount', [alice.address, USDC, { amount: 10_000_000 }, TOKEN_PROGRAM_ADDRESS]);
        await cheat('surfnet_setTokenAccount', [bob.address, USDC, { amount: 100_000 }, TOKEN_PROGRAM_ADDRESS]);

        [planPda] = await findPlanPda({ owner: merchant.address, planId });
        await send(merchant, [
            await getCreatePlanOverlayInstructionAsync({
                owner: merchant,
                planId,
                mint: USDC,
                amount: PRICE,
                periodHours: PERIOD_HOURS,
                endTs: 0,
                destinations: [merchant.address],
                pullers: [puller.address],
                metadataUri: 'https://example.com/e2e-plan.json',
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
        ]);
        aliceSub = await subscribe(alice);
        bobSub = await subscribe(bob);

        db = await connectPglite();
        await migrate(db);
        repo = new Repo(db);
        chain = new SolanaChain({ rpcUrl: RPC_URL, wsUrl: WS_URL, signer: puller });
    }, 120_000);

    afterAll(async () => {
        await db?.close();
    });

    it('indexes the plan and both subscriptions', async () => {
        const res = await syncOnce({ repo, chain, scope: 'managed', log });
        expect(res.plans).toBe(1);
        expect(res.subscriptions).toBe(2);
        expect((await repo.getPlan(planPda))?.pullers).toEqual([puller.address]);
    }, 60_000);

    it('charges period 1 as the puller, creating the merchant ATA; preflight blocks the underfunded subscriber', async () => {
        const res = await cycle();
        expect(res).toMatchObject({ charged: 1, failed: 1 });
        expect(await usdcBalance(alice.address)).toBe(10_000_000n - PRICE);
        expect(await usdcBalance(merchant.address)).toBe(PRICE);
        expect(await usdcBalance(bob.address)).toBe(100_000n);

        const [bobAttempt] = await repo.listAttempts({ subscription: bobSub });
        expect(bobAttempt).toMatchObject({ status: 'failed', reason: 'insufficient_funds', signature: null });
        const [aliceAttempt] = await repo.listAttempts({ subscription: aliceSub });
        expect(aliceAttempt?.status).toBe('succeeded');
        expect(aliceAttempt?.signature).toBeTruthy();

        const [paid] = await repo.listEvents({ type: 'payment.succeeded' });
        expect(paid?.data).toMatchObject({
            subscription: aliceSub,
            subscriber: alice.address,
            mint: USDC,
            amount: PRICE.toString(),
            signature: aliceAttempt?.signature,
        });
        const [failed] = await repo.listEvents({ type: 'payment.failed' });
        expect(failed?.data).toMatchObject({ subscription: bobSub, reason: 'insufficient_funds', final: false });

        // On-chain state agrees after re-sync.
        await syncOnce({ repo, chain, scope: 'managed', log });
        expect((await repo.getSubscription(aliceSub))?.amountPulledInPeriod).toBe(PRICE);
    }, 120_000);

    it('does not charge again within the same period', async () => {
        const res = await cycle();
        expect(res.charged).toBe(0);
        expect(await usdcBalance(merchant.address)).toBe(PRICE);
    }, 60_000);

    it('charges period 2 after time travel', async () => {
        await timeTravelSecs(PERIOD_HOURS * 3600n + 60n);
        const res = await cycle();
        expect(res.charged).toBe(1);
        expect(await usdcBalance(merchant.address)).toBe(2n * PRICE);
    }, 120_000);

    it('stops after the subscriber cancels and the period ends', async () => {
        await send(alice, [await getCancelSubscriptionOverlayInstructionAsync({ subscriber: alice, planPda })]);
        await syncOnce({ repo, chain, scope: 'managed', log });
        expect((await repo.getSubscription(aliceSub))?.expiresAtTs).not.toBe(0n);

        const [cancelled] = await repo.listEvents({ type: 'subscription.cancelled' });
        expect(cancelled?.data).toMatchObject({ subscription: aliceSub });

        await timeTravelSecs(PERIOD_HOURS * 3600n + 60n);
        const res = await cycle();
        expect(res.charged).toBe(0);
        expect(await usdcBalance(merchant.address)).toBe(2n * PRICE);
    }, 120_000);

    it('delivers every recorded event as a verifiable webhook', async () => {
        const secret = generateSecret();
        const received: unknown[] = [];
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', c => (body += c));
            req.on('end', () => {
                received.push(new Webhook(secret).verify(body, req.headers as Record<string, string>));
                res.writeHead(204).end();
            });
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        try {
            const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
            const cfg = { url, secrets: [secret], timeoutMs: 5000, retryScheduleSecs: [60], batchSize: 20 };
            const res = await deliverDueEvents({ repo, cfg, log });
            expect(res.failed).toBe(0);
            const recorded = await repo.listEvents();
            const got = received as { id: string; type: string }[];
            expect(got.map(e => e.id)).toEqual(recorded.map(e => e.eventId));
            expect(new Set(got.map(e => e.type))).toEqual(
                new Set([
                    'subscription.created',
                    'subscription.cancelled',
                    'payment.succeeded',
                    'payment.failed',
                ]),
            );
            expect(got.filter(e => e.type === 'payment.succeeded')).toHaveLength(2);
        } finally {
            await new Promise(r => server.close(r));
        }
    }, 60_000);
});
