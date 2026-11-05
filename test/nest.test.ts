import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer, type Server } from '../src/api/server.js';
import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { LoopsModule } from '../src/worker/loops.js';
import { log } from './fixtures.js';

let db: Db;
let repo: Repo;
let server: Server | null = null;

beforeEach(async () => {
    db = await connectPglite();
    await migrate(db);
    repo = new Repo(db);
});
afterEach(async () => {
    await server?.close();
    server = null;
    await db.close();
});

describe('NestJS API', () => {
    it('keeps /health open when an API key is set, and guards everything else', async () => {
        server = await buildServer({ repo, graceSecs: 0n, apiKey: 'k'.repeat(20) });
        expect((await server.inject({ url: '/health' })).json()).toEqual({ ok: true });
        const denied = await server.inject({ url: '/plans' });
        expect([denied.statusCode, denied.json()]).toEqual([401, { error: 'unauthorized' }]);
        const wrong = await server.inject({ url: '/plans', headers: { authorization: `Bearer ${'x'.repeat(20)}` } });
        expect(wrong.statusCode).toBe(401);
        const ok = await server.inject({ url: '/plans', headers: { authorization: `Bearer ${'k'.repeat(20)}` } });
        expect(ok.statusCode).toBe(200);
    });

    it('returns a JSON-safe 400 even when validation issues carry bigints', async () => {
        server = await buildServer({ repo, graceSecs: 0n });
        const res = await server.inject({ url: '/events?after=-1' });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'bad_request', issues: [{ path: ['after'], minimum: '0' }] });
    });

    it('answers unknown routes with 404 and missing records with not_found', async () => {
        server = await buildServer({ repo, graceSecs: 0n });
        expect((await server.inject({ url: '/nope' })).statusCode).toBe(404);
        const missing = await server.inject({ url: `/plans/${'1'.repeat(32)}` });
        expect([missing.statusCode, missing.json()]).toEqual([404, { error: 'not_found' }]);
        const redeliver = await server.inject({ method: 'POST', url: `/events/evt_${'0'.repeat(32)}/redeliver` });
        expect(redeliver.statusCode).toBe(404);
    });
});

describe('billing loops', () => {
    it('run sync and charge, then on shutdown finish the charge in flight before closing the database', async () => {
        const order: string[] = [];
        let releaseCharge!: () => void;
        const chargeStarted = new Promise<void>(started => {
            server = null;
            void buildServer(
                { repo, graceSecs: 0n },
                {
                    imports: [
                        LoopsModule.forRoot({
                            sync: async () => void order.push('sync'),
                            charge: () => {
                                order.push('charge:start');
                                started();
                                return new Promise<void>(done => {
                                    releaseCharge = () => {
                                        order.push('charge:end');
                                        done();
                                    };
                                });
                            },
                            syncIntervalSecs: 3600,
                            chargeIntervalSecs: 0,
                            webhookIntervalSecs: 3600,
                            log,
                            onShutdown: async () => void order.push('db:close'),
                        }),
                    ],
                },
            ).then(s => (server = s));
        });
        await chargeStarted;
        while (!server) await new Promise(r => setTimeout(r, 5));
        const closing = server.close();
        server = null;
        await new Promise(r => setTimeout(r, 20));
        expect(order).not.toContain('db:close'); // still waiting for the charge
        releaseCharge();
        await closing;
        expect(order).toEqual(['sync', 'charge:start', 'charge:end', 'db:close']);
    });

    it('stops promptly instead of waiting out the sync interval', async () => {
        let syncs = 0;
        server = await buildServer(
            { repo, graceSecs: 0n },
            {
                imports: [
                    LoopsModule.forRoot({
                        sync: async () => void syncs++,
                        syncIntervalSecs: 3600,
                        chargeIntervalSecs: 3600,
                        webhookIntervalSecs: 3600,
                        log,
                    }),
                ],
            },
        );
        await new Promise(r => setTimeout(r, 20));
        const t0 = Date.now();
        await server.close();
        server = null;
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(syncs).toBe(1);
    });
});
