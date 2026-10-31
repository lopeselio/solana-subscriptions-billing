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

type Row = Record<string, unknown>;
const big = (v: unknown): bigint => BigInt(v as string | number | bigint);
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));

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

    async upsertSubscription(s: Omit<SubscriptionRecord, 'closed'>): Promise<void> {
        await this.db.query(
            `INSERT INTO subscriptions (address, plan, subscriber, payer, amount, period_hours, terms_created_at,
                                        amount_pulled_in_period, current_period_start_ts, expires_at_ts, closed, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,now())
             ON CONFLICT (address) DO UPDATE SET
                plan = EXCLUDED.plan, subscriber = EXCLUDED.subscriber, payer = EXCLUDED.payer,
                amount = EXCLUDED.amount, period_hours = EXCLUDED.period_hours,
                terms_created_at = EXCLUDED.terms_created_at,
                amount_pulled_in_period = EXCLUDED.amount_pulled_in_period,
                current_period_start_ts = EXCLUDED.current_period_start_ts,
                expires_at_ts = EXCLUDED.expires_at_ts, closed = FALSE, synced_at = now()`,
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

    /** Marks a plan's tracked subscriptions that no longer exist on-chain as closed. */
    async markSubscriptionsClosedExcept(plan: string, existing: string[]): Promise<number> {
        const res = await this.db.query<{ address: string }>(
            `UPDATE subscriptions SET closed = TRUE, synced_at = now()
             WHERE plan = $1 AND closed = FALSE AND NOT (address = ANY($2::text[]))
             RETURNING address`,
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

    async succeedAttempt(id: bigint, signature: string): Promise<void> {
        await this.db.query(
            `UPDATE charge_attempts SET status = 'succeeded', signature = $2, reason = NULL, error = NULL,
                    next_retry_at = NULL, updated_at = now()
             WHERE id = $1`,
            [id.toString(), signature],
        );
    }

    async failAttempt(id: bigint, reason: FailureReason, error: string, nextRetryAt: Date | null): Promise<void> {
        await this.db.query(
            `UPDATE charge_attempts SET status = 'failed', reason = $2, error = $3, next_retry_at = $4, updated_at = now()
             WHERE id = $1`,
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
}
