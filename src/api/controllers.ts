import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { computeEntitlement } from '../core/billing.js';
import type { Repo } from '../db/repo.js';
import { NotFound, Zod } from './http.js';
import { API_OPTIONS, type ApiSettings, REPO } from './tokens.js';
import { attemptView, json, snapshot, subscriptionView, wallet } from './views.js';

const limit = z.coerce.number().int().min(1).max(1000).optional();

@Controller()
export class HealthController {
    @Get('health')
    health() {
        return { ok: true };
    }
}

@Controller('plans')
export class PlansController {
    constructor(
        @Inject(REPO) private readonly repo: Repo,
        @Inject(API_OPTIONS) private readonly settings: ApiSettings,
    ) {}

    @Get()
    async list() {
        return json(await this.repo.listPlans());
    }

    @Get(':address')
    async get(@Param(new Zod(z.object({ address: wallet }))) { address }: { address: string }) {
        const plan = await this.repo.getPlan(address);
        if (!plan) throw new NotFound();
        const subs = await this.repo.listSubscriptions({ plan: address });
        const t = this.settings.now();
        return json({ ...plan, subscriptions: subs.map(s => subscriptionView(s, plan, t, this.settings.graceSecs)) });
    }
}

@Controller('subscriptions')
export class SubscriptionsController {
    constructor(
        @Inject(REPO) private readonly repo: Repo,
        @Inject(API_OPTIONS) private readonly settings: ApiSettings,
    ) {}

    @Get(':address')
    async get(@Param(new Zod(z.object({ address: wallet }))) { address }: { address: string }) {
        const sub = await this.repo.getSubscription(address);
        if (!sub) throw new NotFound();
        const plan = await this.repo.getPlan(sub.plan);
        const attempts = await this.repo.listAttempts({ subscription: address, limit: 50 });
        const payments = await this.repo.listChainEvents({ kind: 'subscription_transfer', subscription: address, limit: 50 });
        return json({
            ...subscriptionView(sub, plan, this.settings.now(), this.settings.graceSecs),
            attempts: attempts.map(attemptView),
            payments,
        });
    }
}

/** Is this wallet allowed access right now? Optionally scoped to one plan. */
@Controller('entitlements')
export class EntitlementsController {
    constructor(
        @Inject(REPO) private readonly repo: Repo,
        @Inject(API_OPTIONS) private readonly settings: ApiSettings,
    ) {}

    @Get(':wallet')
    async get(
        @Param(new Zod(z.object({ wallet }))) params: { wallet: string },
        @Query(new Zod(z.object({ plan: wallet.optional() }))) query: { plan?: string },
    ) {
        const subs = await this.repo.listSubscriptions({ subscriber: params.wallet, plan: query.plan });
        const t = this.settings.now();
        const items = await Promise.all(
            subs.map(async s => {
                const plan = await this.repo.getPlan(s.plan);
                return {
                    subscription: s.address,
                    plan: s.plan,
                    ...computeEntitlement(snapshot(s), { endTs: plan?.endTs ?? 0n }, t, this.settings.graceSecs),
                };
            }),
        );
        return json({ wallet: params.wallet, entitled: items.some(i => i.entitled), subscriptions: items });
    }
}

const chargesQuery = z.object({
    status: z.enum(['pending', 'succeeded', 'failed']).optional(),
    subscription: wallet.optional(),
    limit,
});

@Controller('charges')
export class ChargesController {
    constructor(@Inject(REPO) private readonly repo: Repo) {}

    @Get()
    async list(@Query(new Zod(chargesQuery)) q: z.infer<typeof chargesQuery>) {
        return json((await this.repo.listAttempts(q)).map(attemptView));
    }
}

const paymentsQuery = z.object({
    plan: wallet.optional(),
    subscription: wallet.optional(),
    subscriber: wallet.optional(),
    limit,
});

/** On-chain payment ledger (every subscription transfer, by any puller), newest first. */
@Controller('payments')
export class PaymentsController {
    constructor(@Inject(REPO) private readonly repo: Repo) {}

    @Get()
    async list(@Query(new Zod(paymentsQuery)) q: z.infer<typeof paymentsQuery>) {
        return json(await this.repo.listChainEvents({ ...q, kind: 'subscription_transfer' }));
    }
}

const eventsQuery = z.object({
    after: z.coerce.bigint().min(0n).optional(),
    type: z.string().max(64).optional(),
    limit,
});
const eventId = z.object({ eventId: z.string().regex(/^evt_[0-9a-f]{32}$/) });

/** Event log, oldest first. Poll with `after` = the last id seen; same events as the webhooks. */
@Controller('events')
export class EventsController {
    constructor(@Inject(REPO) private readonly repo: Repo) {}

    @Get()
    async list(@Query(new Zod(eventsQuery)) q: z.infer<typeof eventsQuery>) {
        return json(await this.repo.listEvents(q));
    }

    /** Re-queue an event for webhook delivery (e.g. after fixing a receiver), with a fresh retry budget. */
    @Post(':eventId/redeliver')
    @HttpCode(202)
    async redeliver(@Param(new Zod(eventId)) { eventId: id }: z.infer<typeof eventId>) {
        if (!(await this.repo.redeliverEvent(id))) throw new NotFound();
        return { eventId: id, deliveryStatus: 'pending' };
    }
}

export const CONTROLLERS = [
    HealthController,
    PlansController,
    SubscriptionsController,
    EntitlementsController,
    ChargesController,
    PaymentsController,
    EventsController,
];
