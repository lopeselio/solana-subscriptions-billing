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
    getTransferSubscriptionOverlayInstructionAsync,
} from '@solana/subscriptions';
import pino from 'pino';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SolanaChain } from '../../src/chain/solana.js';
import { connectPglite, type Db, migrate } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { refreshEntitlements } from '../../src/indexer/entitlements.js';
import { ingestEvents } from '../../src/indexer/ingest.js';
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
const GRACE_SECS = 1800n;
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

    async function subscribe(user: KeyPairSigner, plan = { pda: planPda, id: planId }) {
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
        const { data: planAccount } = await fetchPlan(rpc, plan.pda);
        await send(user, [
            await getSubscribeOverlayInstructionAsync({
                subscriber: user,
                merchant: merchant.address,
                planId: plan.id,
                tokenMint: USDC,
                expectedAmount: planAccount.data.terms.amount,
                expectedPeriodHours: planAccount.data.terms.periodHours,
                expectedCreatedAt: planAccount.data.terms.createdAt,
                expectedSubscriptionAuthorityInitId: authority.initId,
            }),
        ]);
        const [sub] = await findSubscriptionDelegationPda({ planPda: plan.pda, subscriber: user.address });
        return sub;
    }

    // Same order as the service loop: sync, event ingestion, entitlement pass (cluster time), charge.
    const ingest = () => ingestEvents({ repo, chain, scope: 'managed', log });
    const cycle = async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        await ingest();
        await refreshEntitlements({ repo, now: await chain.clusterTime(), graceSecs: GRACE_SECS, log });
        return runChargeCycle({ repo, chain, cfg, log });
    };
    const statuses = async (sub: Address) =>
        (await repo.listEvents({ type: 'entitlement.changed' }))
            .filter(e => e.data.subscription === sub)
            .map(e => e.data.status);

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
        chain = new SolanaChain({ rpcUrl: RPC_URL, wsUrl: WS_URL, signer: puller, ingestCommitment: 'confirmed' });
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

    it('ingests the deployed program\'s events: the worker\'s transfers, without double-announcing them', async () => {
        await ingest();
        const transfers = await repo.listChainEvents({ kind: 'subscription_transfer', subscription: aliceSub });
        const attempts = await repo.listAttempts({ subscription: aliceSub, status: 'succeeded' });
        expect(transfers.map(t => t.signature).sort()).toEqual(attempts.map(a => a.signature).sort());
        const [merchantAta] = await findAssociatedTokenPda({ owner: merchant.address, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        expect(transfers[0]!.data).toMatchObject({
            plan: planPda,
            delegator: alice.address,
            mint: USDC,
            amount: PRICE.toString(),
            amountPulledInPeriod: PRICE.toString(),
            receiver: merchant.address,
            receiverTokenAccount: merchantAta,
            puller: puller.address,
        });
        const created = await repo.listChainEvents({ kind: 'subscription_created' });
        expect(created.map(c => c.subscription).sort()).toEqual([aliceSub, bobSub].sort());
        expect((await repo.listEvents({ type: 'payment.succeeded' })).every(e => e.data.source === 'worker')).toBe(true);
    }, 60_000);

    it('announces a pull made outside the worker (the merchant pulling directly)', async () => {
        const [merchantAta] = await findAssociatedTokenPda({ owner: merchant.address, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        await send(merchant, [
            await getTransferSubscriptionOverlayInstructionAsync({
                amount: 50_000n,
                caller: merchant,
                delegator: bob.address,
                planPda,
                receiverAta: merchantAta,
                subscriptionPda: bobSub,
                tokenMint: USDC,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
                transferHookAccounts: [],
            }),
        ]);
        await ingest();
        const external = (await repo.listEvents({ type: 'payment.succeeded' })).filter(e => e.data.source === 'chain');
        expect(external).toHaveLength(1);
        expect(external[0]!.data).toMatchObject({
            subscription: bobSub,
            subscriber: bob.address,
            puller: merchant.address,
            amount: '50000',
            amountPulledInPeriod: '50000',
        });
        expect(await usdcBalance(bob.address)).toBe(50_000n);
    }, 60_000);

    it('stops after the subscriber cancels and the period ends', async () => {
        await send(alice, [await getCancelSubscriptionOverlayInstructionAsync({ subscriber: alice, planPda })]);
        await syncOnce({ repo, chain, scope: 'managed', log });
        expect((await repo.getSubscription(aliceSub))?.expiresAtTs).not.toBe(0n);

        const [cancelled] = await repo.listEvents({ type: 'subscription.cancelled' });
        expect(cancelled?.data).toMatchObject({ subscription: aliceSub });
        await ingest();
        const [onChain] = await repo.listChainEvents({ kind: 'subscription_cancelled' });
        expect(onChain).toMatchObject({ subscription: aliceSub, subscriber: alice.address });
        expect(onChain!.data.expiresAtTs).toBe((await repo.getSubscription(aliceSub))!.expiresAtTs.toString());

        await timeTravelSecs(PERIOD_HOURS * 3600n + 60n);
        const res = await cycle();
        expect(res.charged).toBe(0);
        expect(await usdcBalance(merchant.address)).toBe(2n * PRICE + 50_000n); // + the merchant's own pull from bob
    }, 120_000);

    it('announces entitlement changes at cluster time', async () => {
        // alice: unpaid -> paid -> period 2 due -> access ended by her cancellation
        expect(await statuses(aliceSub)).toEqual(['grace', 'active', 'grace', 'cancelled']);
        // bob never paid; grace ran out after the first time travel
        expect(await statuses(bobSub)).toEqual(['grace', 'past_due']);
    });

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
                    'entitlement.changed',
                ]),
            );
            expect(got.filter(e => e.type === 'payment.succeeded')).toHaveLength(3); // 2 by the worker, 1 by the merchant
        } finally {
            await new Promise(r => server.close(r));
        }
    }, 60_000);

    it('batches charges for one plan: 5 subscribers go out as 4 + 1 transactions', async () => {
        const id = planId + 1n;
        const [pda] = await findPlanPda({ owner: merchant.address, planId: id });
        await send(merchant, [
            await getCreatePlanOverlayInstructionAsync({
                owner: merchant,
                planId: id,
                mint: USDC,
                amount: PRICE,
                periodHours: PERIOD_HOURS,
                endTs: 0,
                destinations: [merchant.address],
                pullers: [puller.address],
                metadataUri: 'https://example.com/e2e-batch-plan.json',
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
        ]);
        const users = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
        for (const u of users) await rpc.requestAirdrop(u.address, lamports(1_000_000_000n)).send();
        for (const u of users) {
            for (let i = 0; (await rpc.getBalance(u.address).send()).value === 0n; i++) {
                if (i > 50) throw new Error('airdrop never landed');
                await new Promise(r => setTimeout(r, 200));
            }
            await cheat('surfnet_setTokenAccount', [u.address, USDC, { amount: 3_000_000 }, TOKEN_PROGRAM_ADDRESS]);
        }
        const subs = [];
        for (const u of users) subs.push(await subscribe(u, { pda, id }));

        const before = await usdcBalance(merchant.address);
        await syncOnce({ repo, chain, scope: 'managed', log });
        await runChargeCycle({ repo, chain, cfg: { ...cfg, batchSize: 4 }, log });

        const sigs = await Promise.all(subs.map(async s => (await repo.listAttempts({ subscription: s }))[0]));
        expect(sigs.every(a => a?.status === 'succeeded')).toBe(true);
        const bySig = new Map<string, number>();
        for (const a of sigs) bySig.set(a!.signature!, (bySig.get(a!.signature!) ?? 0) + 1);
        expect([...bySig.values()].sort()).toEqual([1, 4]);
        expect(await usdcBalance(merchant.address)).toBe(before + 5n * PRICE);
        for (const u of users) expect(await usdcBalance(u.address)).toBe(3_000_000n - PRICE);

        // The 4-transfer transaction's events are all matched to the worker's attempts.
        await ingest();
        const transfers = await repo.listChainEvents({ kind: 'subscription_transfer', plan: pda });
        expect(transfers).toHaveLength(5);
        expect(transfers.filter(t => t.signature === [...bySig].find(([, n]) => n === 4)![0]).map(t => t.eventIndex).sort())
            .toEqual([0, 1, 2, 3]);
        const chainSourced = (await repo.listEvents({ type: 'payment.succeeded' })).filter(e => e.data.plan === pda && e.data.source === 'chain');
        expect(chainSourced).toHaveLength(0);
    }, 180_000);
});
