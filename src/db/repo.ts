import type { FailureReason } from '../core/billing.js';
import type { Db } from './db.js';

export interface PlanRecord {
    address: string;
    owner: string;
    planId: bigint;
    mint: string;
    amount: bigint;
    periodHours: bigint;
    termsCreatedAt: bigint;
    endTs: bigint;
    status: number;
    destinations: string[];
    pullers: string[];
    metadataUri: string;
    closed: boolean;
}

export interface SubscriptionRecord {
    address: string;
    plan: string;
    subscriber: string;
    payer: string;
    amount: bigint;
    periodHours: bigint;
    termsCreatedAt: bigint;
    amountPulledInPeriod: bigint;
    currentPeriodStartTs: bigint;
    expiresAtTs: bigint;
    closed: boolean;
}

export type AttemptStatus = 'pending' | 'succeeded' | 'failed';

export interface ChargeAttempt {
    id: bigint;
    subscription: string;
    plan: string;
    periodStartTs: bigint;
    attemptNo: number;
    amount: bigint;
    status: AttemptStatus;
    reason: FailureReason | null;
    error: string | null;
    signature: string | null;
    nextRetryAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export type EventType =
    | 'subscription.created'
    | 'subscription.cancelled'
    | 'subscription.resumed'
    | 'subscription.closed'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'entitlement.changed';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface EventRecord {
    id: bigint;
    eventId: string;
    type: EventType;
    data: Record<string, unknown>;
    createdAt: Date;
    deliveryStatus: DeliveryStatus;
    deliveryAttempts: number;
    nextDeliveryAt: Date;
    lastError: string | null;
    deliveredAt: Date | null;
}

type Row = Record<string, unknown>;
const big = (v: unknown): bigint => BigInt(v as string | number | bigint);
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));

// Event payloads are built in SQL so each event is inserted in the same statement as
// the state change that caused it (an outbox without explicit transactions).
// Token amounts and timestamps are strings, as in the HTTP API.
const subscriptionJson = (t: string) => `jsonb_build_object(
    'subscription', ${t}.address, 'plan', ${t}.plan, 'subscriber', ${t}.subscriber, 'payer', ${t}.payer,
    'amount', ${t}.amount::text, 'periodHours', ${t}.period_hours::text,
    'currentPeriodStartTs', ${t}.current_period_start_ts::text,
    'amountPulledInPeriod', ${t}.amount_pulled_in_period::text, 'expiresAtTs', ${t}.expires_at_ts::text)`;

const paymentJson = (a: string) => `jsonb_build_object(
    'attemptId', ${a}.id::text, 'subscription', ${a}.subscription, 'plan', ${a}.plan,
    'subscriber', s.subscriber, 'mint', p.mint, 'amount', ${a}.amount::text,
    'periodStartTs', ${a}.period_start_ts::text, 'attemptNo', ${a}.attempt_no, 'signature', ${a}.signature)`;

const paymentJoins = (a: string) =>
    `LEFT JOIN subscriptions s ON s.address = ${a}.subscription LEFT JOIN plans p ON p.address = ${a}.plan`;

function toPlan(r: Row): PlanRecord {
    return {
        address: r.address as string,
        owner: r.owner as string,
        planId: big(r.plan_id),
        mint: r.mint as string,
        amount: big(r.amount),
        periodHours: big(r.period_hours),
        termsCreatedAt: big(r.terms_created_at),
        endTs: big(r.end_ts),
        status: Number(r.status),
        destinations: r.destinations as string[],
        pullers: r.pullers as string[],
        metadataUri: r.metadata_uri as string,
        closed: r.closed as boolean,
    };
}

function toSubscription(r: Row): SubscriptionRecord {
    return {
        address: r.address as string,
        plan: r.plan as string,
        subscriber: r.subscriber as string,
        payer: r.payer as string,
        amount: big(r.amount),
        periodHours: big(r.period_hours),
        termsCreatedAt: big(r.terms_created_at),
        amountPulledInPeriod: big(r.amount_pulled_in_period),
        currentPeriodStartTs: big(r.current_period_start_ts),
        expiresAtTs: big(r.expires_at_ts),
        closed: r.closed as boolean,
    };
}

function toAttempt(r: Row): ChargeAttempt {
    return {
        id: big(r.id),
        subscription: r.subscription as string,
        plan: r.plan as string,
        periodStartTs: big(r.period_start_ts),
        attemptNo: Number(r.attempt_no),
        amount: big(r.amount),
        status: r.status as AttemptStatus,
        reason: (r.reason as FailureReason | null) ?? null,
        error: (r.error as string | null) ?? null,
        signature: (r.signature as string | null) ?? null,
        nextRetryAt: r.next_retry_at == null ? null : date(r.next_retry_at),
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
    };
}

function toEvent(r: Row): EventRecord {
    return {
        id: big(r.id),
        eventId: r.event_id as string,
        type: r.type as EventType,
        data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, unknown>,
        createdAt: date(r.created_at),
        deliveryStatus: r.delivery_status as DeliveryStatus,
        deliveryAttempts: Number(r.delivery_attempts),
        nextDeliveryAt: date(r.next_delivery_at),
        lastError: (r.last_error as string | null) ?? null,
        deliveredAt: r.delivered_at == null ? null : date(r.delivered_at),
    };
}

export class Repo {
    constructor(private readonly db: Db) {}

    // ---- plans ----

    async upsertPlan(p: Omit<PlanRecord, 'closed'>): Promise<void> {
        await this.db.query(
            `INSERT INTO plans (address, owner, plan_id, mint, amount, period_hours, terms_created_at, end_ts,
                                status, destinations, pullers, metadata_uri, closed, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,now())
             ON CONFLICT (address) DO UPDATE SET
                owner = EXCLUDED.owner, plan_id = EXCLUDED.plan_id, mint = EXCLUDED.mint,
                amount = EXCLUDED.amount, period_hours = EXCLUDED.period_hours,
                terms_created_at = EXCLUDED.terms_created_at, end_ts = EXCLUDED.end_ts,
                status = EXCLUDED.status, destinations = EXCLUDED.destinations,
                pullers = EXCLUDED.pullers, metadata_uri = EXCLUDED.metadata_uri,
                closed = FALSE, synced_at = now()`,
            [
                p.address,
                p.owner,
                p.planId.toString(),
                p.mint,
                p.amount.toString(),
                p.periodHours.toString(),
                p.termsCreatedAt.toString(),
                p.endTs.toString(),
                p.status,
                p.destinations,
                p.pullers,
                p.metadataUri,
            ],
        );
    }

    /** Marks tracked plans that no longer exist on-chain as closed. `existing` is every live plan address. */
    async markPlansClosedExcept(existing: string[]): Promise<number> {
        const res = await this.db.query<{ address: string }>(
            `UPDATE plans SET closed = TRUE, synced_at = now()
             WHERE closed = FALSE AND NOT (address = ANY($1::text[]))
             RETURNING address`,
            [existing],
        );
        return res.rows.length;
    }

    async listPlans(opts: { includeClosed?: boolean } = {}): Promise<PlanRecord[]> {
        const res = await this.db.query(
            `SELECT * FROM plans ${opts.includeClosed ? '' : 'WHERE closed = FALSE'} ORDER BY first_seen_at`,
        );
        return res.rows.map(toPlan);
    }

    async getPlan(address: string): Promise<PlanRecord | null> {
        const res = await this.db.query(`SELECT * FROM plans WHERE address = $1`, [address]);
        return res.rows[0] ? toPlan(res.rows[0]) : null;
    }

    // ---- subscriptions ----

    /**
     * Upserts a subscription snapshot. Emits `subscription.created` the first time an address is
     * seen (or reappears after closing), `subscription.cancelled` when `expiresAtTs` is set or moved,
     * and `subscription.resumed` when it is cleared.
     */
    async upsertSubscription(s: Omit<SubscriptionRecord, 'closed'>): Promise<void> {
        await this.db.query(
            `WITH prev AS (SELECT expires_at_ts, closed FROM subscriptions WHERE address = $1),
             up AS (
                INSERT INTO subscriptions (address, plan, subscriber, payer, amount, period_hours, terms_created_at,
                                           amount_pulled_in_period, current_period_start_ts, expires_at_ts, closed, synced_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,now())
                ON CONFLICT (address) DO UPDATE SET
                   plan = EXCLUDED.plan, subscriber = EXCLUDED.subscriber, payer = EXCLUDED.payer,
                   amount = EXCLUDED.amount, period_hours = EXCLUDED.period_hours,
                   terms_created_at = EXCLUDED.terms_created_at,
                   amount_pulled_in_period = EXCLUDED.amount_pulled_in_period,
                   current_period_start_ts = EXCLUDED.current_period_start_ts,
                   expires_at_ts = EXCLUDED.expires_at_ts, closed = FALSE, synced_at = now()
                RETURNING *)
             INSERT INTO events (type, data)
             SELECT ev.type, ${subscriptionJson('up')}
             FROM up
             LEFT JOIN prev ON TRUE
             CROSS JOIN LATERAL (SELECT CASE
                 WHEN prev.closed IS NULL OR prev.closed THEN 'subscription.created'
                 -- also when CancelSubscriptionNow moves a pending cancellation earlier
                 WHEN up.expires_at_ts <> 0 AND up.expires_at_ts <> prev.expires_at_ts THEN 'subscription.cancelled'
                 WHEN prev.expires_at_ts <> 0 AND up.expires_at_ts = 0 THEN 'subscription.resumed'
             END AS type) ev
             WHERE ev.type IS NOT NULL`,
            [
                s.address,
                s.plan,
                s.subscriber,
                s.payer,
                s.amount.toString(),
                s.periodHours.toString(),
                s.termsCreatedAt.toString(),
                s.amountPulledInPeriod.toString(),
                s.currentPeriodStartTs.toString(),
                s.expiresAtTs.toString(),
            ],
        );
    }

    /** Marks a plan's tracked subscriptions that no longer exist on-chain as closed; emits `subscription.closed`. */
    async markSubscriptionsClosedExcept(plan: string, existing: string[]): Promise<number> {
        const res = await this.db.query<{ address: string }>(
            `WITH c AS (
                UPDATE subscriptions SET closed = TRUE, synced_at = now()
                WHERE plan = $1 AND closed = FALSE AND NOT (address = ANY($2::text[]))
                RETURNING *),
             ev AS (INSERT INTO events (type, data) SELECT 'subscription.closed', ${subscriptionJson('c')} FROM c)
             SELECT address FROM c`,
            [plan, existing],
        );
        return res.rows.length;
    }

    async listSubscriptions(filter: { plan?: string; subscriber?: string; includeClosed?: boolean } = {}) {
        const where: string[] = [];
        const params: unknown[] = [];
        if (!filter.includeClosed) where.push('closed = FALSE');
        if (filter.plan) {
            params.push(filter.plan);
            where.push(`plan = $${params.length}`);
        }
        if (filter.subscriber) {
            params.push(filter.subscriber);
            where.push(`subscriber = $${params.length}`);
        }
        const res = await this.db.query(
            `SELECT * FROM subscriptions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY first_seen_at`,
            params,
        );
        return res.rows.map(toSubscription);
    }

    async getSubscription(address: string): Promise<SubscriptionRecord | null> {
        const res = await this.db.query(`SELECT * FROM subscriptions WHERE address = $1`, [address]);
        return res.rows[0] ? toSubscription(res.rows[0]) : null;
    }

    /** Subscriptions whose entitlement may need re-evaluating: open ones, and closed ones not yet announced. */
    async listForEntitlement(): Promise<
        { sub: SubscriptionRecord; planEndTs: bigint; entitlementStatus: string | null }[]
    > {
        const res = await this.db.query(
            `SELECT s.*, COALESCE(p.end_ts, 0) AS plan_end_ts FROM subscriptions s
             LEFT JOIN plans p ON p.address = s.plan
             WHERE NOT s.closed OR s.entitlement_status IS DISTINCT FROM 'closed'
             ORDER BY s.first_seen_at`,
        );
        return res.rows.map(r => ({
            sub: toSubscription(r),
            planEndTs: big(r.plan_end_ts),
            entitlementStatus: (r.entitlement_status as string | null) ?? null,
        }));
    }

    /**
     * Compare-and-set the stored entitlement status from `from` to `to.status`, emitting
     * `entitlement.changed` in the same statement. Returns false (and emits nothing) if another
     * process already moved it.
     */
    async setEntitlement(
        address: string,
        from: string | null,
        to: { status: string; entitled: boolean; accessUntilTs: bigint | null },
    ): Promise<boolean> {
        const res = await this.db.query(
            `WITH u AS (
                UPDATE subscriptions SET entitlement_status = $3
                WHERE address = $1 AND entitlement_status IS NOT DISTINCT FROM $2::text
                RETURNING *)
             INSERT INTO events (type, data)
             SELECT 'entitlement.changed', ${subscriptionJson('u')} || jsonb_build_object(
                    'previousStatus', $2::text, 'status', $3::text, 'entitled', $4::boolean,
                    'accessUntilTs', $5::text)
             FROM u
             RETURNING id`,
            [address, from, to.status, to.entitled, to.accessUntilTs?.toString() ?? null],
        );
        return res.rows.length > 0;
    }

    // ---- charge attempts ----

    /**
     * Inserts a pending attempt for (subscription, period). Returns null if a pending or
     * succeeded attempt already exists for that period — the caller must not charge.
     */
    async beginAttempt(a: {
        subscription: string;
        plan: string;
        periodStartTs: bigint;
        amount: bigint;
    }): Promise<ChargeAttempt | null> {
        const res = await this.db.query(
            `INSERT INTO charge_attempts (subscription, plan, period_start_ts, attempt_no, amount, status)
             SELECT $1, $2, $3,
                    COALESCE((SELECT max(attempt_no) FROM charge_attempts
                              WHERE subscription = $1 AND period_start_ts = $3), 0) + 1,
                    $4, 'pending'
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [a.subscription, a.plan, a.periodStartTs.toString(), a.amount.toString()],
        );
        return res.rows[0] ? toAttempt(res.rows[0]) : null;
    }

    async setAttemptSignature(id: bigint, signature: string): Promise<void> {
        await this.db.query(`UPDATE charge_attempts SET signature = $2, updated_at = now() WHERE id = $1`, [
            id.toString(),
            signature,
        ]);
    }

    /** Marks an attempt succeeded and emits `payment.succeeded` (once; a repeat call is a no-op). */
    async succeedAttempt(id: bigint, signature: string): Promise<void> {
        await this.db.query(
            `WITH a AS (
                UPDATE charge_attempts SET status = 'succeeded', signature = $2, reason = NULL, error = NULL,
                       next_retry_at = NULL, updated_at = now()
                WHERE id = $1 AND status <> 'succeeded'
                RETURNING *)
             INSERT INTO events (type, data)
             SELECT 'payment.succeeded', ${paymentJson('a')} FROM a ${paymentJoins('a')}`,
            [id.toString(), signature],
        );
    }

    /**
     * Marks a pending attempt failed and emits `payment.failed`. `final` in the payload is true
     * when no retry is scheduled (terminal reason or retry schedule exhausted).
     */
    async failAttempt(id: bigint, reason: FailureReason, error: string, nextRetryAt: Date | null): Promise<void> {
        await this.db.query(
            `WITH a AS (
                UPDATE charge_attempts SET status = 'failed', reason = $2, error = $3, next_retry_at = $4, updated_at = now()
                WHERE id = $1 AND status = 'pending'
                RETURNING *)
             INSERT INTO events (type, data)
             SELECT 'payment.failed', ${paymentJson('a')} || jsonb_build_object(
                    'reason', a.reason, 'error', a.error, 'nextRetryAt', a.next_retry_at,
                    'final', a.next_retry_at IS NULL)
             FROM a ${paymentJoins('a')}`,
            [id.toString(), reason, error.slice(0, 2000), nextRetryAt],
        );
    }

    /** Most recent attempt for a subscription period, if any. */
    async lastAttempt(subscription: string, periodStartTs: bigint): Promise<ChargeAttempt | null> {
        const res = await this.db.query(
            `SELECT * FROM charge_attempts WHERE subscription = $1 AND period_start_ts = $2
             ORDER BY attempt_no DESC LIMIT 1`,
            [subscription, periodStartTs.toString()],
        );
        return res.rows[0] ? toAttempt(res.rows[0]) : null;
    }

    async listPendingAttempts(): Promise<ChargeAttempt[]> {
        const res = await this.db.query(`SELECT * FROM charge_attempts WHERE status = 'pending' ORDER BY id`);
        return res.rows.map(toAttempt);
    }

    async listAttempts(
        filter: { subscription?: string; status?: AttemptStatus; limit?: number } = {},
    ): Promise<ChargeAttempt[]> {
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter.subscription) {
            params.push(filter.subscription);
            where.push(`subscription = $${params.length}`);
        }
        if (filter.status) {
            params.push(filter.status);
            where.push(`status = $${params.length}`);
        }
        params.push(Math.min(filter.limit ?? 100, 1000));
        const res = await this.db.query(
            `SELECT * FROM charge_attempts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY id DESC LIMIT $${params.length}`,
            params,
        );
        return res.rows.map(toAttempt);
    }

    // ---- events ----

    async listEvents(filter: { after?: bigint; type?: string; limit?: number } = {}): Promise<EventRecord[]> {
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter.after !== undefined) {
            params.push(filter.after.toString());
            where.push(`id > $${params.length}`);
        }
        if (filter.type) {
            params.push(filter.type);
            where.push(`type = $${params.length}`);
        }
        params.push(Math.min(filter.limit ?? 100, 1000));
        const res = await this.db.query(
            `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY id LIMIT $${params.length}`,
            params,
        );
        return res.rows.map(toEvent);
    }

    /**
     * Claims up to `limit` due events for delivery. Each claimed event is leased for `leaseSecs`
     * (its next_delivery_at is pushed out) so concurrent dispatchers don't send it twice.
     */
    async claimDueEvents(limit: number, leaseSecs: number): Promise<EventRecord[]> {
        const res = await this.db.query(
            `UPDATE events SET next_delivery_at = now() + make_interval(secs => $2),
                               delivery_attempts = delivery_attempts + 1
             WHERE id IN (SELECT id FROM events
                          WHERE delivery_status = 'pending' AND next_delivery_at <= now()
                          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
             RETURNING *`,
            [limit, leaseSecs],
        );
        return res.rows.map(toEvent).sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    async markEventDelivered(id: bigint): Promise<void> {
        await this.db.query(
            `UPDATE events SET delivery_status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1`,
            [id.toString()],
        );
    }

    /** Records a failed delivery; `nextAt` null means retries are exhausted. */
    async markEventDeliveryFailed(id: bigint, error: string, nextAt: Date | null): Promise<void> {
        await this.db.query(
            `UPDATE events SET last_error = $2,
                    delivery_status = CASE WHEN $3::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
                    next_delivery_at = COALESCE($3::timestamptz, next_delivery_at)
             WHERE id = $1`,
            [id.toString(), error.slice(0, 2000), nextAt],
        );
    }

    /** Queues an event for delivery again with a fresh retry budget. Returns false if unknown. */
    async redeliverEvent(eventId: string): Promise<boolean> {
        const res = await this.db.query(
            `UPDATE events SET delivery_status = 'pending', delivery_attempts = 0, next_delivery_at = now(),
                               last_error = NULL, delivered_at = NULL
             WHERE event_id = $1 RETURNING id`,
            [eventId],
        );
        return res.rows.length > 0;
    }
}
