import type { Address } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { ingestEvents } from '../src/indexer/ingest.js';
import { syncOnce } from '../src/indexer/sync.js';
import { runChargeCycle } from '../src/worker/charge.js';
import { FakeChain } from './fake-chain.js';
import { ALICE, cfg, log, MERCHANT, PLAN, PULLER, seed, SUB } from './fixtures.js';

let db: Db;
let repo: Repo;
let chain: FakeChain;

const sync = () => syncOnce({ repo, chain, scope: 'managed', log });
const ingest = (opts: { maxTransactions?: number; backfill?: boolean } = {}) =>
    ingestEvents({ repo, chain, scope: 'managed', log, ...opts });
const charge = () => runChargeCycle({ repo, chain, cfg, log });
const payments = () => repo.listEvents({ type: 'payment.succeeded' });
const createPlanTx = () => chain.record([], { addresses: [PLAN] }); // CreatePlan emits no event

beforeEach(async () => {
    db = await connectPglite();
    await migrate(db);
    repo = new Repo(db);
    chain = new FakeChain(PULLER);
    seed(chain);
});
afterEach(async () => {
    await db.close();
});

describe('live ingestion', () => {
    beforeEach(async () => {
        createPlanTx();
        await sync();
        await ingest(); // tracking starts at the plan's creation
    });

    it("records the worker's own charge in the ledger without announcing it twice", async () => {
        await charge();
        expect(await ingest()).toEqual({ transactions: 1, events: 1 });

        const [transfer] = await repo.listChainEvents({ kind: 'subscription_transfer' });
        expect(transfer).toMatchObject({ signature: 'sig2', plan: PLAN, subscription: SUB, subscriber: ALICE });
        expect(transfer!.data).toMatchObject({ amount: '500', puller: PULLER, delegator: ALICE });

        const paid = await payments();
        expect(paid).toHaveLength(1);
        expect(paid[0]!.data.source).toBe('worker');
    });

    it('announces pulls by other pullers, and the worker then sees the period as paid', async () => {
        const sig = chain.externalPull(SUB, 500n, MERCHANT);
        await ingest();
        const [paid] = await payments();
        expect(paid!.data).toMatchObject({
            source: 'chain',
            signature: sig,
            subscription: SUB,
            subscriber: ALICE,
            puller: MERCHANT,
            amount: '500',
            amountPulledInPeriod: '500',
        });

        await sync();
        expect((await charge()).charged).toBe(0);
        expect(chain.sent).toHaveLength(0);
    });

    it('does not announce a transfer whose signature belongs to an unfinished worker attempt', async () => {
        // Crash window: the worker persisted the signature, the transaction landed, the attempt is still pending.
        const sig = chain.externalPull(SUB, 500n, PULLER);
        const attempt = await repo.beginAttempt({ subscription: SUB, plan: PLAN, periodStartTs: chain.now, amount: 500n });
        await repo.setAttemptSignature(attempt!.id, sig);
        await ingest();
        expect(await payments()).toHaveLength(0);
        expect(await repo.listChainEvents()).toHaveLength(1);
    });

    it('is idempotent across passes', async () => {
        chain.externalPull(SUB, 200n, MERCHANT);
        chain.externalPull(SUB, 300n, MERCHANT);
        expect(await ingest()).toEqual({ transactions: 2, events: 2 });
        expect(await ingest()).toEqual({ transactions: 0, events: 0 });
        expect(await payments()).toHaveLength(2);
    });

    it('skips failed transactions but moves past them', async () => {
        chain.record([], { failed: true, addresses: [PLAN] });
        chain.externalPull(SUB, 500n, MERCHANT);
        expect(await ingest()).toEqual({ transactions: 2, events: 1 });
    });

    it('stops at a transaction that is not available yet and resumes from it in order', async () => {
        const first = chain.externalPull(SUB, 200n, MERCHANT);
        chain.externalPull(SUB, 300n, MERCHANT);
        chain.unavailable.add(first);
        expect(await ingest()).toEqual({ transactions: 0, events: 0 });
        chain.unavailable.clear();
        await ingest();
        expect((await payments()).map(e => e.data.amountPulledInPeriod)).toEqual(['200', '500']);
    });

    it('processes oldest first within a per-pass budget', async () => {
        for (const amount of [100n, 100n, 100n]) chain.externalPull(SUB, amount, MERCHANT);
        expect(await ingest({ maxTransactions: 2 })).toEqual({ transactions: 2, events: 2 });
        expect(await ingest({ maxTransactions: 2 })).toEqual({ transactions: 1, events: 1 });
        expect((await payments()).map(e => e.data.amountPulledInPeriod)).toEqual(['100', '200', '300']);
    });

    it('keeps only tracked plans from a transaction that touches several', async () => {
        const other = 'Other1111111111111111111111111111111111111' as Address;
        chain.record([
            { kind: 'subscription_cancelled', plan: other, subscriber: ALICE as Address, expiresAtTs: 1n },
            { kind: 'subscription_cancelled', plan: PLAN as Address, subscriber: ALICE as Address, expiresAtTs: 2n },
        ]);
        expect(await ingest()).toEqual({ transactions: 1, events: 1 });
        const [cancel] = await repo.listChainEvents();
        // Lifecycle events get the subscription address derived from (plan, subscriber).
        expect(cancel).toMatchObject({ kind: 'subscription_cancelled', eventIndex: 1, subscription: SUB, subscriber: ALICE });
        expect(cancel!.data).toEqual({ plan: PLAN, subscriber: ALICE, expiresAtTs: '2' });
        expect(await payments()).toHaveLength(0); // lifecycle webhooks come from the snapshot diff
    });

    it('serves the ledger at GET /payments and on the subscription', async () => {
        await charge();
        chain.now += 720n * 3600n;
        await sync();
        chain.externalPull(SUB, 500n, MERCHANT);
        await ingest();
        const app = buildServer({ repo, graceSecs: 0n });
        const all = (await app.inject({ url: `/payments?subscription=${SUB}` })).json() as { data: { puller: string } }[];
        expect(all.map(p => p.data.puller)).toEqual([MERCHANT, PULLER]); // newest first
        const sub = (await app.inject({ url: `/subscriptions/${SUB}` })).json() as { payments: unknown[] };
        expect(sub.payments).toHaveLength(2);
    });
});

describe('history from before tracking started', () => {
    beforeEach(() => {
        createPlanTx();
        for (const amount of [100n, 100n, 100n]) chain.externalPull(SUB, amount, MERCHANT);
    });

    it('is backfilled into the ledger but not announced', async () => {
        await sync();
        expect(await ingest()).toEqual({ transactions: 4, events: 3 });
        expect(await repo.listChainEvents({ kind: 'subscription_transfer' })).toHaveLength(3);
        expect(await payments()).toHaveLength(0);

        chain.externalPull(SUB, 100n, MERCHANT); // after tracking started: announced
        await ingest();
        expect((await payments()).map(e => e.data.amountPulledInPeriod)).toEqual(['400']);
    });

    it('backfills in budgeted steps, after live work', async () => {
        await sync();
        expect(await ingest({ maxTransactions: 2 })).toEqual({ transactions: 2, events: 2 }); // newest + 1 older
        chain.externalPull(SUB, 100n, MERCHANT);
        expect(await ingest({ maxTransactions: 2 })).toEqual({ transactions: 2, events: 2 }); // live first, then 1 older
        expect(await payments()).toHaveLength(1);
        expect(await ingest({ maxTransactions: 2 })).toEqual({ transactions: 1, events: 0 }); // the CreatePlan tx
        expect(await ingest({ maxTransactions: 2 })).toEqual({ transactions: 0, events: 0 }); // done
        expect(await repo.listChainEvents()).toHaveLength(4);
    });

    it('is skipped with backfill disabled', async () => {
        await sync();
        expect(await ingest({ backfill: false })).toEqual({ transactions: 0, events: 0 });
        expect(await repo.listChainEvents()).toHaveLength(0);
    });

    it('is not re-announced after the cursor is lost', async () => {
        await sync();
        await ingest();
        await db.query(`DELETE FROM sync_state`);
        await ingest();
        expect(await repo.listChainEvents()).toHaveLength(3);
        expect(await payments()).toHaveLength(0);
    });

    it('scans program-wide history with PLAN_SCOPE=all', async () => {
        await sync();
        const res = await ingestEvents({ repo, chain, scope: 'all', log });
        expect(res).toEqual({ transactions: 4, events: 3 });
        expect(await repo.getState(`ingest:${chain.programAddress}`)).toBe('sig4');
        expect(await repo.getState(`ingest-backfill:${chain.programAddress}`)).toBe('done');
    });
});
