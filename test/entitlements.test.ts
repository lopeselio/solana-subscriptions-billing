import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { refreshEntitlements } from '../src/indexer/entitlements.js';
import { syncOnce } from '../src/indexer/sync.js';
import { runChargeCycle } from '../src/worker/charge.js';
import { FakeChain } from './fake-chain.js';
import { ALICE, cfg, HOUR, log, MINT, PLAN, PULLER, seed, SUB } from './fixtures.js';

const GRACE = 72n * HOUR;
const PERIOD = 720n * HOUR;

let db: Db;
let repo: Repo;
let chain: FakeChain;

/** One iteration of the service loop: sync, entitlement pass, charge. */
async function tick({ charge = true } = {}) {
    await syncOnce({ repo, chain, scope: 'managed', log });
    await refreshEntitlements({ repo, now: chain.now, graceSecs: GRACE, log });
    if (charge) await runChargeCycle({ repo, chain, cfg, log });
}
const refresh = () => refreshEntitlements({ repo, now: chain.now, graceSecs: GRACE, log });

async function transitions() {
    const events = await repo.listEvents({ type: 'entitlement.changed' });
    return events.map(e => `${e.data.previousStatus ?? 'null'}->${e.data.status}`);
}

function starve() {
    chain.sources.set(`${ALICE}:${MINT}`, {
        exists: true,
        amount: 0n,
        delegate: `SA:${ALICE}:${MINT}`,
        delegatedAmount: 2n ** 64n - 1n,
    });
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

describe('entitlement.changed', () => {
    it('follows a paying subscription: grace until the first charge lands, then active', async () => {
        const start = chain.now;
        await tick(); // sees it unpaid (grace), then charges
        await tick(); // snapshot now shows the pull
        await tick();
        expect(await transitions()).toEqual(['null->grace', 'grace->active']);

        const [first, second] = await repo.listEvents({ type: 'entitlement.changed' });
        expect(first!.data).toMatchObject({
            subscription: SUB,
            plan: PLAN,
            subscriber: ALICE,
            entitled: true,
            accessUntilTs: (start + GRACE).toString(),
        });
        expect(second!.data).toMatchObject({ entitled: true, accessUntilTs: (start + PERIOD).toString() });
    });

    it('goes past_due when grace runs out without payment, and recovers when paid', async () => {
        starve();
        await tick();
        chain.now += GRACE - 1n;
        await tick();
        chain.now += 1n;
        await tick();
        expect(await transitions()).toEqual(['null->grace', 'grace->past_due']);
        const [, pastDue] = await repo.listEvents({ type: 'entitlement.changed' });
        expect(pastDue!.data).toMatchObject({ entitled: false, accessUntilTs: null });

        chain.sources.delete(`${ALICE}:${MINT}`);
        await db.query(`UPDATE charge_attempts SET next_retry_at = now()`); // retry is due
        await tick();
        await tick();
        expect((await transitions()).at(-1)).toBe('past_due->active');
    });

    it('announces cancelling, then cancelled when access ends', async () => {
        await tick();
        await tick();
        const s = chain.subs.get(SUB)!;
        chain.subs.set(SUB, { ...s, expiresAtTs: s.currentPeriodStartTs + PERIOD });
        await tick();
        chain.now += PERIOD;
        await tick();
        expect(await transitions()).toEqual([
            'null->grace',
            'grace->active',
            'active->cancelling',
            'cancelling->cancelled',
        ]);
    });

    it('announces plan_ended and closed, and stops evaluating closed subscriptions', async () => {
        await tick({ charge: false });
        const plan = chain.plans.get(PLAN)!;
        chain.plans.set(PLAN, { ...plan, endTs: chain.now - 1n });
        await tick({ charge: false });
        chain.subs.delete(SUB);
        await tick({ charge: false });
        chain.now += PERIOD;
        await tick({ charge: false });
        expect(await transitions()).toEqual(['null->grace', 'grace->plan_ended', 'plan_ended->closed']);
        expect(await repo.listForEntitlement()).toHaveLength(0);
    });

    it('does not repeat an unchanged status, even from concurrent passes', async () => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        const counts = await Promise.all([refresh(), refresh(), refresh()]);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
        expect(await refresh()).toBe(0);
        expect(await transitions()).toEqual(['null->grace']);
    });
});
