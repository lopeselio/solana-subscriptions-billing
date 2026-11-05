import { z } from 'zod';

import { computeChargeState, computeEntitlement } from '../core/billing.js';
import type { ChargeAttempt, PlanRecord, SubscriptionRecord } from '../db/repo.js';

/** A base58 Solana address. */
export const wallet = z.string().min(32).max(44);

/** JSON-safe view: bigint -> string, Date -> ISO. */
export function json<T>(v: T): unknown {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

export function snapshot(s: SubscriptionRecord) {
    return {
        amountPerPeriod: s.amount,
        periodHours: s.periodHours,
        currentPeriodStartTs: s.currentPeriodStartTs,
        amountPulledInPeriod: s.amountPulledInPeriod,
        expiresAtTs: s.expiresAtTs,
    };
}

/** A subscription with its billing state and entitlement as of `now`. */
export function subscriptionView(s: SubscriptionRecord, plan: PlanRecord | null, now: bigint, graceSecs: bigint) {
    const planSnap = { endTs: plan?.endTs ?? 0n };
    return {
        ...s,
        billing: computeChargeState(snapshot(s), planSnap, now),
        entitlement: s.closed
            ? { status: 'closed', entitled: false, accessUntilTs: null }
            : computeEntitlement(snapshot(s), planSnap, now, graceSecs),
    };
}

export function attemptView(a: ChargeAttempt) {
    return { ...a };
}
