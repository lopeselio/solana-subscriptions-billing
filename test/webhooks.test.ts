import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Webhook } from 'standardwebhooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { ChargeError } from '../src/chain/types.js';
import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { type EventRecord, Repo } from '../src/db/repo.js';
import { syncOnce } from '../src/indexer/sync.js';
import { deliverDueEvents, type WebhookConfig } from '../src/webhooks/dispatcher.js';
import { generateSecret, secretKey, signedHeaders } from '../src/webhooks/signature.js';
import { runChargeCycle } from '../src/worker/charge.js';
import { FakeChain } from './fake-chain.js';
import { ALICE, cfg, HOUR, log, MINT, PLAN, PULLER, seed, SUB } from './fixtures.js';

let db: Db;
let repo: Repo;
let chain: FakeChain;

const sync = () => syncOnce({ repo, chain, scope: 'managed', log });
const cycle = async () => {
    await sync();
    return runChargeCycle({ repo, chain, cfg, log });
};
const types = async () => (await repo.listEvents()).map(e => e.type);
const ofType = async (type: string) => repo.listEvents({ type });

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

describe('signing', () => {
    it('produces signatures the reference Standard Webhooks library accepts, for every active secret', () => {
        const [current, previous] = [generateSecret(), generateSecret()];
        const body = JSON.stringify({ type: 'payment.succeeded', data: { amount: '500' } });
        const headers = signedHeaders([current, previous], 'evt_abc', body);
        expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
        for (const secret of [current, previous]) {
            expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
        }
    });

    it('fails verification for a tampered body or an unknown secret', () => {
        const secret = generateSecret();
        const headers = signedHeaders([secret], 'evt_abc', '{"a":1}');
        expect(() => new Webhook(secret).verify('{"a":2}', headers)).toThrow();
        expect(() => new Webhook(generateSecret()).verify('{"a":1}', headers)).toThrow();
    });

    it('rejects malformed secrets', () => {
        expect(() => secretKey('whsec_short')).toThrow();
        expect(() => secretKey('whsec_not base64!')).toThrow();
        expect(secretKey(generateSecret())).toHaveLength(32);
    });
});

describe('event emission', () => {
    it('emits subscription.created once, not on every sync', async () => {
        await sync();
        await sync();
        const created = await ofType('subscription.created');
        expect(created).toHaveLength(1);
        expect(created[0]!.data).toMatchObject({ subscription: SUB, plan: PLAN, subscriber: ALICE, amount: '500' });
        expect(created[0]!.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    });

    it('emits subscription.cancelled when expiresAt becomes set, once', async () => {
        await sync();
        const s = chain.subs.get(SUB)!;
        const expiresAtTs = s.currentPeriodStartTs + 720n * HOUR;
        chain.subs.set(SUB, { ...s, expiresAtTs });
        await sync();
        await sync();
        const cancelled = await ofType('subscription.cancelled');
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]!.data.expiresAtTs).toBe(expiresAtTs.toString());
    });

    it('emits subscription.closed when the account disappears, and created again if it comes back', async () => {
        await sync();
        const s = chain.subs.get(SUB)!;
        chain.subs.delete(SUB);
        await sync();
        await sync();
        chain.subs.set(SUB, s);
        await sync();
        expect(await types()).toEqual(['subscription.created', 'subscription.closed', 'subscription.created']);
    });

    it('emits payment.succeeded with the transaction signature, once per charge', async () => {
        await cycle();
        await cycle(); // same period: nothing new
        const paid = await ofType('payment.succeeded');
        expect(paid).toHaveLength(1);
        expect(paid[0]!.data).toMatchObject({
            subscription: SUB,
            plan: PLAN,
            subscriber: ALICE,
            mint: MINT,
            amount: '500',
            attemptNo: 1,
            signature: 'sig1',
        });

        // A repeated success update (e.g. reconcile racing the worker) does not emit twice.
        const [attempt] = await repo.listAttempts({ subscription: SUB });
        await repo.succeedAttempt(attempt!.id, 'sig1');
        expect(await ofType('payment.succeeded')).toHaveLength(1);
    });

    it('emits payment.failed with the reason and whether a retry is scheduled', async () => {
        chain.sources.set(`${ALICE}:${MINT}`, {
            exists: true,
            amount: 10n,
            delegate: `SA:${ALICE}:${MINT}`,
            delegatedAmount: 2n ** 64n - 1n,
        });
        await cycle();
        const [failed] = await ofType('payment.failed');
        expect(failed!.data).toMatchObject({ reason: 'insufficient_funds', final: false, signature: null });
        expect(typeof failed!.data.nextRetryAt).toBe('string');
    });

    it('marks terminal failures final', async () => {
        chain.failNext = new ChargeError('subscription_cancelled', 'program error 508');
        await cycle();
        const [failed] = await ofType('payment.failed');
        expect(failed!.data).toMatchObject({ reason: 'subscription_cancelled', final: true, nextRetryAt: null });
    });
});

describe('delivery', () => {
    let server: Server;
    let url: string;
    let received: { headers: IncomingHttpHeaders; body: string }[];
    let respond: () => number;
    const secret = generateSecret();
    const whCfg = (): WebhookConfig => ({
        url,
        secrets: [secret],
        timeoutMs: 2000,
        retryScheduleSecs: [60, 600],
        batchSize: 20,
    });
    const deliver = () => deliverDueEvents({ repo, cfg: whCfg(), log });
    const event = async (id: bigint) => (await repo.listEvents()).find(e => e.id === id)!;
    /** Makes a leased or scheduled event due now, as if time had passed. */
    const makeDue = (e: EventRecord) =>
        db.query(`UPDATE events SET next_delivery_at = now() - interval '1 second' WHERE id = $1`, [e.id.toString()]);

    beforeEach(async () => {
        received = [];
        respond = () => 204;
        server = createServer((req, res) => {
            let body = '';
            req.on('data', c => (body += c));
            req.on('end', () => {
                received.push({ headers: req.headers, body });
                res.writeHead(respond()).end();
            });
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
    });
    afterEach(async () => {
        await new Promise(r => server.close(r));
    });

    it('POSTs signed events in order and marks them delivered', async () => {
        await cycle();
        expect(await deliver()).toEqual({ delivered: 2, failed: 0 });
        expect(await deliver()).toEqual({ delivered: 0, failed: 0 });

        const payloads = received.map(r => new Webhook(secret).verify(r.body, r.headers as Record<string, string>));
        expect(payloads.map(p => (p as { type: string }).type)).toEqual(['subscription.created', 'payment.succeeded']);
        const events = await repo.listEvents();
        expect(received.map(r => r.headers['webhook-id'])).toEqual(events.map(e => e.eventId));
        expect(events.every(e => e.deliveryStatus === 'delivered' && e.deliveryAttempts === 1)).toBe(true);
        expect(payloads[1]).toMatchObject({ id: events[1]!.eventId, data: { amount: '500', signature: 'sig1' } });
    });

    it('retries on a non-2xx response per the schedule, then gives up', async () => {
        await sync();
        respond = () => 500;
        const [e] = await repo.listEvents();

        expect(await deliver()).toEqual({ delivered: 0, failed: 1 });
        let after = await event(e!.id);
        expect(after).toMatchObject({ deliveryStatus: 'pending', deliveryAttempts: 1, lastError: 'HTTP 500' });
        expect(after.nextDeliveryAt.getTime() - Date.now()).toBeGreaterThan(50_000);
        expect(await deliver()).toEqual({ delivered: 0, failed: 0 }); // not due yet

        await makeDue(after);
        await deliver();
        await makeDue(after);
        await deliver();
        after = await event(e!.id);
        expect(after).toMatchObject({ deliveryStatus: 'failed', deliveryAttempts: 3 });
        expect(received).toHaveLength(3);
        // Same id on every attempt so receivers can dedupe.
        expect(new Set(received.map(r => r.headers['webhook-id'])).size).toBe(1);
    });

    it('treats unreachable endpoints and redirects as failures', async () => {
        await sync();
        respond = () => 302;
        await deliver();
        const [e] = await repo.listEvents();
        expect((await event(e!.id)).lastError).toBe('HTTP 302');

        await makeDue(e!);
        await new Promise(r => server.close(r));
        server.listen(0); // keep afterEach's close() valid
        await deliver();
        expect((await event(e!.id)).lastError).toMatch(/fetch failed|ECONNREFUSED/);
    });

    it('does not hand the same event to two concurrent dispatchers', async () => {
        await sync();
        const [a, b] = await Promise.all([deliver(), deliver()]);
        expect(a.delivered + b.delivered).toBe(1);
        expect(received).toHaveLength(1);
    });

    it('redelivers a failed event on request via the API', async () => {
        await sync();
        respond = () => 500;
        const quickCfg = { ...whCfg(), retryScheduleSecs: [] };
        await deliverDueEvents({ repo, cfg: quickCfg, log });
        const [e] = await repo.listEvents();
        expect((await event(e!.id)).deliveryStatus).toBe('failed');

        const app = buildServer({ repo, graceSecs: 0n });
        const missing = await app.inject({ method: 'POST', url: '/events/evt_00000000000000000000000000000000/redeliver' });
        expect(missing.statusCode).toBe(404);
        const res = await app.inject({ method: 'POST', url: `/events/${e!.eventId}/redeliver` });
        expect(res.statusCode).toBe(202);

        respond = () => 200;
        expect(await deliver()).toEqual({ delivered: 1, failed: 0 });
        expect(await event(e!.id)).toMatchObject({ deliveryStatus: 'delivered', deliveryAttempts: 1, lastError: null });
    });
});

describe('GET /events', () => {
    it('pages through the event log with after=<id>', async () => {
        await cycle();
        chain.now += 720n * HOUR;
        await cycle();
        const app = buildServer({ repo, graceSecs: 0n });

        const first = (await app.inject({ url: '/events?limit=2' })).json() as { id: string; type: string }[];
        expect(first.map(e => e.type)).toEqual(['subscription.created', 'payment.succeeded']);
        const rest = (await app.inject({ url: `/events?after=${first[1]!.id}` })).json() as { type: string }[];
        expect(rest.map(e => e.type)).toEqual(['payment.succeeded']);

        const paid = (await app.inject({ url: '/events?type=payment.succeeded' })).json() as unknown[];
        expect(paid).toHaveLength(2);
        expect((await app.inject({ url: '/events?after=-1' })).statusCode).toBe(400);
    });
});
