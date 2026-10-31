import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChargeError } from '../src/chain/types.js';
import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { ingestEvents } from '../src/indexer/ingest.js';
import { syncOnce } from '../src/indexer/sync.js';
import { runChargeCycle, type WorkerConfig } from '../src/worker/charge.js';
import { FakeChain } from './fake-chain.js';
import { cfg as baseCfg, log, PLAN, PULLER, seed, SUB } from './fixtures.js';

let db: Db;
let repo: Repo;
let chain: FakeChain;
const cfg: WorkerConfig = { ...baseCfg, batchSize: 3 };

/** Adds `n` more due subscriptions to `plan`, returning all of that plan's subscription addresses. */
function addSubscribers(n: number, plan = PLAN): string[] {
    const template = chain.subs.get(SUB)!;
    for (let i = 0; i < n; i++) {
        const address = `${plan.slice(0, 5)}Sub${i}`;
        chain.subs.set(address, { ...template, address, plan, subscriber: `${plan.slice(0, 5)}User${i}` });
    }
    return [...chain.subs.values()].filter(s => s.plan === plan).map(s => s.address);
}

async function cycle(c: WorkerConfig = cfg) {
    await syncOnce({ repo, chain, scope: 'managed', log });
    return runChargeCycle({ repo, chain, cfg: c, log });
}
const attempts = async (sub: string) => repo.listAttempts({ subscription: sub });

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

describe('batched charging', () => {
    it('charges a plan in transactions of up to batchSize, one signature per batch', async () => {
        const subs = addSubscribers(4); // 5 in total
        expect(await cycle()).toMatchObject({ charged: 5, failed: 0 });
        expect(chain.batches).toEqual([3, 2]);

        const sigs = await Promise.all(subs.map(async s => (await attempts(s))[0]!.signature));
        expect(new Set(sigs).size).toBe(2);
        expect(await repo.listEvents({ type: 'payment.succeeded' })).toHaveLength(5);
        expect((await cycle()).charged).toBe(0); // all periods paid
    });

    it('never mixes plans in a transaction', async () => {
        const other = 'Plan2222222222222222222222222222222222222222';
        chain.plans.set(other, { ...chain.plans.get(PLAN)!, address: other, planId: 2n });
        addSubscribers(1); // 2 on PLAN
        addSubscribers(2, other); // 2 on the other plan
        await cycle({ ...cfg, batchSize: 10 });
        expect(chain.batches).toEqual([2, 2]);
        expect(new Set(chain.sent.slice(0, 2).map(r => r.plan.address)).size).toBe(1);
    });

    it('fails only the charge a batch error points to, and sends the rest singly', async () => {
        const subs = addSubscribers(2); // 3 in total
        chain.rejects.set(subs[1]!, new ChargeError('subscription_cancelled', 'program error 508'));
        expect(await cycle()).toMatchObject({ charged: 2, failed: 1 });
        expect(chain.batches).toEqual([3, 1, 1]);
        expect((await attempts(subs[1]!))[0]).toMatchObject({ status: 'failed', reason: 'subscription_cancelled' });
        for (const s of [subs[0]!, subs[2]!]) {
            const [a] = await attempts(s);
            expect(a).toMatchObject({ status: 'succeeded', attemptNo: 1 });
        }
    });

    it('falls back to single transactions when a batch cannot be sent (e.g. too large)', async () => {
        addSubscribers(3); // 4 in total
        chain.batchLimit = 2;
        expect(await cycle({ ...cfg, batchSize: 4 })).toMatchObject({ charged: 4, failed: 0 });
        expect(chain.batches).toEqual([1, 1, 1, 1]);
    });

    it('retries everything singly when a batch fails without naming an instruction', async () => {
        addSubscribers(2);
        chain.failNext = new ChargeError('program_error', 'account in use');
        expect(await cycle()).toMatchObject({ charged: 3, failed: 0 });
        expect(chain.batches).toEqual([3, 1, 1, 1]);
    });

    it('leaves a whole batch pending when its outcome is unknown, then reconciles it', async () => {
        const subs = addSubscribers(2);
        chain.timeoutAfterLandingNext = true;
        expect(await cycle()).toMatchObject({ charged: 0, unconfirmed: 3 });
        expect(await cycle()).toMatchObject({ reconciled: 3, charged: 0 });
        for (const s of subs) expect((await attempts(s))[0]!.status).toBe('succeeded');
        expect(chain.batches).toEqual([3]);
    });

    it("matches every transfer in a batch to the worker's attempts when ingesting", async () => {
        chain.record([], { addresses: [PLAN] });
        await syncOnce({ repo, chain, scope: 'managed', log });
        await ingestEvents({ repo, chain, scope: 'managed', log });
        addSubscribers(2);
        await cycle();
        expect(await ingestEvents({ repo, chain, scope: 'managed', log })).toEqual({ transactions: 1, events: 3 });
        const paid = await repo.listEvents({ type: 'payment.succeeded' });
        expect(paid.map(e => e.data.source)).toEqual(['worker', 'worker', 'worker']);
    });
});
