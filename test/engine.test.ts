import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { ChargeError } from '../src/chain/types.js';
import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { syncOnce } from '../src/indexer/sync.js';
import { runChargeCycle } from '../src/worker/charge.js';
import { FakeChain } from './fake-chain.js';
import { ALICE, cfg, HOUR, log, MERCHANT, MINT, PLAN, PULLER, seed, SUB } from './fixtures.js';

let db: Db;
let repo: Repo;
let chain: FakeChain;

async function cycle() {
    await syncOnce({ repo, chain, scope: 'managed', log });
    return runChargeCycle({ repo, chain, cfg, log });
}

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

describe('sync', () => {
    it('tracks only plans the signer can charge in managed scope', async () => {
        chain.plans.set('Other', { ...chain.plans.get(PLAN)!, address: 'Other', owner: 'x', pullers: [] });
        const res = await syncOnce({ repo, chain, scope: 'managed', log });
        expect(res.plans).toBe(1);
        expect((await repo.listPlans()).map(p => p.address)).toEqual([PLAN]);
    });

    it('marks subscriptions closed when their account disappears', async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        chain.subs.delete(SUB);
        const res = await syncOnce({ repo, chain, scope: 'managed', log });
        expect(res.subscriptionsClosed).toBe(1);
        expect((await repo.getSubscription(SUB))?.closed).toBe(true);
    });
});

describe('charging', () => {
    it('charges a new subscription once per period', async () => {
        expect((await cycle()).charged).toBe(1);
        expect(chain.sent[0]).toMatchObject({ amount: 500n, destinationOwner: MERCHANT });

        // Same period: nothing more to do, even before the indexer catches up.
        expect((await runChargeCycle({ repo, chain, cfg, log })).charged).toBe(0);
        expect((await cycle()).charged).toBe(0);

        chain.now += 720n * HOUR;
        expect((await cycle()).charged).toBe(1);
        expect(chain.sent).toHaveLength(2);
    });

    it('skips the transaction and schedules a retry when the balance is short', async () => {
        chain.sources.set(`${ALICE}:${MINT}`, {
            exists: true,
            amount: 10n,
            delegate: `SA:${ALICE}:${MINT}`,
            delegatedAmount: 2n ** 64n - 1n,
        });
        expect((await cycle()).failed).toBe(1);
        expect(chain.sent).toHaveLength(0);

        const [attempt] = await repo.listAttempts({ subscription: SUB });
        expect(attempt).toMatchObject({ status: 'failed', reason: 'insufficient_funds', attemptNo: 1 });
        expect(attempt!.nextRetryAt).not.toBeNull();

        // Before the retry time: skipped.
        expect((await cycle()).failed).toBe(0);
    });

    it('detects a revoked delegate before sending', async () => {
        chain.sources.set(`${ALICE}:${MINT}`, {
            exists: true,
            amount: 10_000n,
            delegate: null,
            delegatedAmount: 0n,
        });
        await cycle();
        expect((await repo.listAttempts({ subscription: SUB }))[0]?.reason).toBe('delegate_revoked');
    });

    it('never retries a terminal failure', async () => {
        chain.failNext = new ChargeError('subscription_cancelled', 'program error 508');
        expect((await cycle()).failed).toBe(1);
        const [attempt] = await repo.listAttempts({ subscription: SUB });
        expect(attempt).toMatchObject({ reason: 'subscription_cancelled', nextRetryAt: null });
    });

    it('stops charging at expiresAt after cancellation', async () => {
        await cycle(); // pays period 1
        const s = chain.subs.get(SUB)!;
        chain.subs.set(SUB, { ...s, expiresAtTs: s.currentPeriodStartTs + 720n * HOUR });
        chain.now += 720n * HOUR;
        expect((await cycle()).charged).toBe(0);
    });

    it('resolves a pending attempt left by a crash from its signature', async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        const a = await repo.beginAttempt({ subscription: SUB, plan: PLAN, periodStartTs: chain.now, amount: 500n });
        await repo.setAttemptSignature(a!.id, 'landed');
        chain.signatures.set('landed', { status: 'succeeded' });

        const res = await runChargeCycle({ repo, chain, cfg, log });
        expect(res.reconciled).toBe(1);
        expect(res.charged).toBe(0); // the landed tx already paid this period
        expect((await repo.listAttempts({ subscription: SUB }))[0]?.status).toBe('succeeded');
    });

    it('refuses a second live attempt for the same period', async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        const first = await repo.beginAttempt({ subscription: SUB, plan: PLAN, periodStartTs: 5n, amount: 1n });
        const second = await repo.beginAttempt({ subscription: SUB, plan: PLAN, periodStartTs: 5n, amount: 1n });
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it('dry run reports without sending or recording', async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        const res = await runChargeCycle({ repo, chain, cfg: { ...cfg, dryRun: true }, log });
        expect(res.wouldCharge).toBe(1);
        expect(chain.sent).toHaveLength(0);
        expect(await repo.listAttempts()).toHaveLength(0);
    });
});

describe('api', () => {
    it('reports entitlement through the payment lifecycle', async () => {
        const graceSecs = 3600n;
        const app = buildServer({ repo, graceSecs, now: () => chain.now, apiKey: 'test-key-0123456789' });
        const get = (url: string) =>
            app.inject({ method: 'GET', url, headers: { authorization: 'Bearer test-key-0123456789' } });

        expect((await app.inject({ method: 'GET', url: '/plans' })).statusCode).toBe(401);

        await syncOnce({ repo, chain, scope: 'managed', log });
        let body = (await get(`/entitlements/${ALICE}`)).json();
        expect(body.subscriptions[0].status).toBe('grace');

        await runChargeCycle({ repo, chain, cfg, log });
        await syncOnce({ repo, chain, scope: 'managed', log });
        body = (await get(`/entitlements/${ALICE}?plan=${PLAN}`)).json();
        expect(body).toMatchObject({ entitled: true, subscriptions: [{ status: 'active' }] });

        chain.now += 720n * HOUR + graceSecs;
        body = (await get(`/entitlements/${ALICE}`)).json();
        expect(body).toMatchObject({ entitled: false, subscriptions: [{ status: 'past_due' }] });

        const sub = (await get(`/subscriptions/${SUB}`)).json();
        expect(sub.attempts[0]).toMatchObject({ status: 'succeeded', amount: '500' });
        await app.close();
    });
});
