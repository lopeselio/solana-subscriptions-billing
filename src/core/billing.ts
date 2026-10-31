/**
 * Pure billing logic. Mirrors the on-chain rules in
 * `program/src/instructions/transfer_subscription.rs` and
 * `helpers/transfer_validation.rs::validate_recurring_transfer` so the worker
 * only submits charges the program will accept.
 */

export const SECS_PER_HOUR = 3600n;

export interface SubscriptionSnapshot {
    /** Amount per period, in base units (copied from plan terms at subscribe time). */
    amountPerPeriod: bigint;
    periodHours: bigint;
    currentPeriodStartTs: bigint;
    amountPulledInPeriod: bigint;
    /** 0 = not cancelled. Otherwise the subscription stops being chargeable at this instant. */
    expiresAtTs: bigint;
}

export interface PlanSnapshot {
    /** 0 = no end. */
    endTs: bigint;
}

export type ChargeState =
    | { kind: 'due'; periodStartTs: bigint; periodEndTs: bigint; amount: bigint }
    | { kind: 'paid'; periodStartTs: bigint; periodEndTs: bigint }
    | { kind: 'not_started'; startsAtTs: bigint }
    | { kind: 'cancelled'; expiredAtTs: bigint }
    | { kind: 'plan_ended'; endedAtTs: bigint };

/** Period the program would bill in at `now`, after its own period advancement. */
export function effectivePeriod(
    sub: SubscriptionSnapshot,
    planEndTs: bigint,
    now: bigint,
): { periodStartTs: bigint; pulled: bigint } {
    const periodLength = sub.periodHours * SECS_PER_HOUR;
    let start = sub.currentPeriodStartTs;
    let pulled = sub.amountPulledInPeriod;
    if (periodLength <= 0n || now < start) return { periodStartTs: start, pulled };

    const elapsed = now - start;
    if (elapsed >= periodLength) {
        const candidate = start + (elapsed / periodLength) * periodLength;
        if (planEndTs === 0n || candidate < planEndTs) {
            start = candidate;
            pulled = 0n;
        } else {
            const lastBillable = planEndTs - 1n;
            if (lastBillable >= start) {
                const lastInBounds = start + ((lastBillable - start) / periodLength) * periodLength;
                if (lastInBounds > start) {
                    start = lastInBounds;
                    pulled = 0n;
                }
            }
        }
    }
    return { periodStartTs: start, pulled };
}

export function computeChargeState(sub: SubscriptionSnapshot, plan: PlanSnapshot, now: bigint): ChargeState {
    // Order matches the program: plan expiry, then subscription expiry, then period checks.
    if (plan.endTs !== 0n && now > plan.endTs) return { kind: 'plan_ended', endedAtTs: plan.endTs };
    if (sub.expiresAtTs !== 0n && now >= sub.expiresAtTs) return { kind: 'cancelled', expiredAtTs: sub.expiresAtTs };
    if (now < sub.currentPeriodStartTs) return { kind: 'not_started', startsAtTs: sub.currentPeriodStartTs };

    const { periodStartTs, pulled } = effectivePeriod(sub, plan.endTs, now);
    let periodEndTs = periodStartTs + sub.periodHours * SECS_PER_HOUR;
    if (plan.endTs !== 0n && periodEndTs > plan.endTs) periodEndTs = plan.endTs;

    const remaining = sub.amountPerPeriod > pulled ? sub.amountPerPeriod - pulled : 0n;
    if (remaining > 0n) return { kind: 'due', periodStartTs, periodEndTs, amount: remaining };
    return { kind: 'paid', periodStartTs, periodEndTs };
}

export type EntitlementStatus =
    | 'active' // current period fully paid
    | 'cancelling' // paid, cancelled, access continues until expiresAt
    | 'grace' // payment due, still inside the grace window
    | 'past_due' // payment due, grace window over
    | 'not_started'
    | 'cancelled'
    | 'plan_ended';

export interface Entitlement {
    status: EntitlementStatus;
    entitled: boolean;
    /** Unix seconds access is paid (or graced) through; null when not entitled. */
    accessUntilTs: bigint | null;
}

/**
 * Start of the earliest period that has not been fully paid, from the stored account state.
 * The account only moves `currentPeriodStartTs` on a pull, so the stored period is either the
 * last one pulled from (unpaid if short) or the subscribe time (nothing pulled yet).
 */
export function firstUnpaidPeriodStart(sub: SubscriptionSnapshot): bigint {
    return sub.amountPulledInPeriod >= sub.amountPerPeriod
        ? sub.currentPeriodStartTs + sub.periodHours * SECS_PER_HOUR
        : sub.currentPeriodStartTs;
}

export function computeEntitlement(
    sub: SubscriptionSnapshot,
    plan: PlanSnapshot,
    now: bigint,
    graceSecs: bigint,
): Entitlement {
    const state = computeChargeState(sub, plan, now);
    switch (state.kind) {
        case 'paid': {
            const cancelling = sub.expiresAtTs !== 0n;
            const until = cancelling && sub.expiresAtTs < state.periodEndTs ? sub.expiresAtTs : state.periodEndTs;
            return { status: cancelling ? 'cancelling' : 'active', entitled: true, accessUntilTs: until };
        }
        case 'due': {
            // Grace runs from the first unpaid period, not the current one; otherwise a
            // subscription that never pays would roll into a fresh grace window every period.
            const graceEnd = firstUnpaidPeriodStart(sub) + graceSecs;
            if (now < graceEnd) return { status: 'grace', entitled: true, accessUntilTs: graceEnd };
            return { status: 'past_due', entitled: false, accessUntilTs: null };
        }
        default:
            return { status: state.kind, entitled: false, accessUntilTs: null };
    }
}

/** Failure reasons the worker distinguishes. Terminal ones are never retried for that period. */
export type FailureReason =
    | 'insufficient_funds'
    | 'delegate_revoked'
    | 'source_account_missing'
    | 'subscription_cancelled'
    | 'plan_ended'
    | 'program_error'
    | 'transient';

// Everything else (including unrecognised program errors) follows the bounded retry schedule.
const TERMINAL: ReadonlySet<FailureReason> = new Set(['subscription_cancelled', 'plan_ended']);

export function isTerminal(reason: FailureReason): boolean {
    return TERMINAL.has(reason);
}

/**
 * Next retry time for a period after `attemptNo` failed attempts (1-based), or null to stop.
 * `scheduleSecs[i]` is the wait after attempt i+1.
 */
export function nextRetryAt(
    reason: FailureReason,
    attemptNo: number,
    failedAt: Date,
    scheduleSecs: readonly number[],
): Date | null {
    if (isTerminal(reason)) return null;
    const wait = scheduleSecs[attemptNo - 1];
    if (wait === undefined) return null;
    return new Date(failedAt.getTime() + wait * 1000);
}
