import { timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { computeChargeState, computeEntitlement } from '../core/billing.js';
import type { ChargeAttempt, PlanRecord, Repo, SubscriptionRecord } from '../db/repo.js';

export interface ApiOptions {
    repo: Repo;
    /** Optional bearer token. When unset the API is open — bind it to localhost. */
    apiKey?: string;
    graceSecs: bigint;
    /** Clock in unix seconds; injectable for tests. */
    now?: () => bigint;
}

const wallet = z.string().min(32).max(44);

/** JSON-safe view: bigint -> string, Date -> ISO. */
function json<T>(v: T): unknown {
    return JSON.parse(
        JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)),
    );
}

function snapshot(s: SubscriptionRecord) {
    return {
        amountPerPeriod: s.amount,
        periodHours: s.periodHours,
        currentPeriodStartTs: s.currentPeriodStartTs,
        amountPulledInPeriod: s.amountPulledInPeriod,
        expiresAtTs: s.expiresAtTs,
    };
}

function view(s: SubscriptionRecord, plan: PlanRecord | null, now: bigint, graceSecs: bigint) {
    const planSnap = { endTs: plan?.endTs ?? 0n };
    return {
        ...s,
        billing: computeChargeState(snapshot(s), planSnap, now),
        entitlement: s.closed
            ? { status: 'closed', entitled: false, accessUntilTs: null }
            : computeEntitlement(snapshot(s), planSnap, now, graceSecs),
    };
}

function attemptView(a: ChargeAttempt) {
    return { ...a };
}

export function buildServer(opts: ApiOptions): FastifyInstance {
    const app = Fastify({ logger: false });
    const now = opts.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    const { repo, graceSecs } = opts;

    if (opts.apiKey) {
        const expected = Buffer.from(`Bearer ${opts.apiKey}`);
        app.addHook('onRequest', async (req, reply) => {
            if (req.url === '/health') return;
            const got = Buffer.from(req.headers.authorization ?? '');
            if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
                return reply.code(401).send({ error: 'unauthorized' });
            }
        });
    }

    app.get('/health', async () => ({ ok: true }));

    app.get('/plans', async () => json(await repo.listPlans()));

    app.get('/plans/:address', async (req, reply) => {
        const { address } = z.object({ address: wallet }).parse(req.params);
        const plan = await repo.getPlan(address);
        if (!plan) return reply.code(404).send({ error: 'not_found' });
        const subs = await repo.listSubscriptions({ plan: address });
        const t = now();
        return json({ ...plan, subscriptions: subs.map(s => view(s, plan, t, graceSecs)) });
    });

    app.get('/subscriptions/:address', async (req, reply) => {
        const { address } = z.object({ address: wallet }).parse(req.params);
        const sub = await repo.getSubscription(address);
        if (!sub) return reply.code(404).send({ error: 'not_found' });
        const plan = await repo.getPlan(sub.plan);
        const attempts = await repo.listAttempts({ subscription: address, limit: 50 });
        return json({ ...view(sub, plan, now(), graceSecs), attempts: attempts.map(attemptView) });
    });

    /** Is this wallet allowed access right now? Optionally scoped to one plan. */
    app.get('/entitlements/:wallet', async req => {
        const params = z.object({ wallet }).parse(req.params);
        const query = z.object({ plan: wallet.optional() }).parse(req.query);
        const subs = await repo.listSubscriptions({ subscriber: params.wallet, plan: query.plan });
        const t = now();
        const items = await Promise.all(
            subs.map(async s => {
                const plan = await repo.getPlan(s.plan);
                return { subscription: s.address, plan: s.plan, ...computeEntitlement(snapshot(s), { endTs: plan?.endTs ?? 0n }, t, graceSecs) };
            }),
        );
        return json({ wallet: params.wallet, entitled: items.some(i => i.entitled), subscriptions: items });
    });

    app.get('/charges', async req => {
        const q = z
            .object({
                status: z.enum(['pending', 'succeeded', 'failed']).optional(),
                subscription: wallet.optional(),
                limit: z.coerce.number().int().min(1).max(1000).optional(),
            })
            .parse(req.query);
        return json((await repo.listAttempts(q)).map(attemptView));
    });

    app.setErrorHandler((err, _req, reply) => {
        if (err instanceof z.ZodError) return reply.code(400).send({ error: 'bad_request', issues: err.issues });
        return reply.code(500).send({ error: 'internal' });
    });

    return app;
}
