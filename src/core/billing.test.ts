import { describe, expect, it } from 'vitest';

import {
    computeChargeState,
    computeEntitlement,
    effectivePeriod,
    nextRetryAt,
    type SubscriptionSnapshot,
} from './billing.js';

const HOUR = 3600n;

function sub(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
    return {
        amountPerPeriod: 100n,
        periodHours: 1n,
        currentPeriodStartTs: 1_000n,
        amountPulledInPeriod: 0n,
        expiresAtTs: 0n,
        ...overrides,
    };
}

describe('effectivePeriod (mirrors validate_recurring_transfer)', () => {
    it('keeps the period while inside it', () => {
        expect(effectivePeriod(sub({ amountPulledInPeriod: 40n }), 0n, 1_000n + HOUR - 1n)).toEqual({
            periodStartTs: 1_000n,
            pulled: 40n,
        });
    });

    it('advances to the floored boundary and resets pulled', () => {
        expect(effectivePeriod(sub({ amountPulledInPeriod: 100n }), 0n, 1_000n + 3n * HOUR + 5n)).toEqual({
            periodStartTs: 1_000n + 3n * HOUR,
            pulled: 0n,
        });
    });

    // Program test `fully_used_final_period_does_not_open_a_period_past_expiry`,
    // scaled to hours: start=2h, pulled=full, expiry=3h, now=3h.
    it('does not open a period at a finite expiry boundary', () => {
        const t = sub({ currentPeriodStartTs: 2n * HOUR, amountPulledInPeriod: 100n });
        expect(effectivePeriod(t, 3n * HOUR, 3n * HOUR)).toEqual({ periodStartTs: 2n * HOUR, pulled: 100n });
    });

    it('advances to the last period starting strictly before plan end', () => {
        const t = sub({ currentPeriodStartTs: 0n, amountPulledInPeriod: 100n });
        expect(effectivePeriod(t, 2n * HOUR, 2n * HOUR)).toEqual({ periodStartTs: HOUR, pulled: 0n });
    });
});

describe('computeChargeState', () => {
    it('is due immediately after subscribe (subscribe pulls nothing)', () => {
        expect(computeChargeState(sub(), { endTs: 0n }, 1_000n)).toEqual({
            kind: 'due',
            periodStartTs: 1_000n,
            periodEndTs: 1_000n + HOUR,
            amount: 100n,
        });
    });

    it('charges only the remainder of a partially pulled period', () => {
        const state = computeChargeState(sub({ amountPulledInPeriod: 30n }), { endTs: 0n }, 1_500n);
        expect(state).toMatchObject({ kind: 'due', amount: 70n });
    });

    it('is paid once the period is fully pulled', () => {
        const state = computeChargeState(sub({ amountPulledInPeriod: 100n }), { endTs: 0n }, 1_500n);
        expect(state).toEqual({ kind: 'paid', periodStartTs: 1_000n, periodEndTs: 1_000n + HOUR });
    });

    it('is due again in the next period', () => {
        const state = computeChargeState(sub({ amountPulledInPeriod: 100n }), { endTs: 0n }, 1_000n + HOUR);
        expect(state).toMatchObject({ kind: 'due', periodStartTs: 1_000n + HOUR, amount: 100n });
    });

    it('stops at expiresAtTs (inclusive, like the program)', () => {
        const s = sub({ expiresAtTs: 1_000n + HOUR });
        expect(computeChargeState(s, { endTs: 0n }, 1_000n + HOUR - 1n).kind).toBe('due');
        expect(computeChargeState(s, { endTs: 0n }, 1_000n + HOUR).kind).toBe('cancelled');
    });

    it('stops after plan end (exclusive, like the program)', () => {
        const end = 1_000n + 10n * HOUR;
        expect(computeChargeState(sub(), { endTs: end }, end).kind).toBe('due');
        expect(computeChargeState(sub(), { endTs: end }, end + 1n).kind).toBe('plan_ended');
    });

    it('clips the period end to the plan end', () => {
        const state = computeChargeState(sub(), { endTs: 1_500n }, 1_200n);
        expect(state).toMatchObject({ kind: 'due', periodEndTs: 1_500n });
    });
});

describe('computeEntitlement', () => {
    const grace = 600n;

    it('active when paid', () => {
        expect(computeEntitlement(sub({ amountPulledInPeriod: 100n }), { endTs: 0n }, 1_100n, grace)).toEqual({
            status: 'active',
            entitled: true,
            accessUntilTs: 1_000n + HOUR,
        });
    });

    it('grace while due inside the window, past_due after', () => {
        expect(computeEntitlement(sub(), { endTs: 0n }, 1_000n + 599n, grace)).toMatchObject({
            status: 'grace',
            entitled: true,
        });
        expect(computeEntitlement(sub(), { endTs: 0n }, 1_000n + 600n, grace)).toMatchObject({
            status: 'past_due',
            entitled: false,
        });
    });

    it('grace does not renew each period for a subscription that never pays', () => {
        // 1h periods, 600s grace, never charged, checked 5 periods later.
        expect(computeEntitlement(sub(), { endTs: 0n }, 1_000n + 5n * HOUR + 10n, grace)).toMatchObject({
            status: 'past_due',
            entitled: false,
        });
    });

    it('grace starts at the period after the last fully paid one', () => {
        const paid = sub({ amountPulledInPeriod: 100n });
        expect(computeEntitlement(paid, { endTs: 0n }, 1_000n + HOUR + 599n, grace).status).toBe('grace');
        expect(computeEntitlement(paid, { endTs: 0n }, 1_000n + HOUR + 600n, grace).status).toBe('past_due');
        expect(computeEntitlement(paid, { endTs: 0n }, 1_000n + 2n * HOUR + 10n, grace).status).toBe('past_due');
    });

    it('cancelling keeps access until expiresAt', () => {
        const s = sub({ amountPulledInPeriod: 100n, expiresAtTs: 1_000n + HOUR });
        expect(computeEntitlement(s, { endTs: 0n }, 1_100n, grace)).toEqual({
            status: 'cancelling',
            entitled: true,
            accessUntilTs: 1_000n + HOUR,
        });
        expect(computeEntitlement(s, { endTs: 0n }, 1_000n + HOUR, grace).entitled).toBe(false);
    });
});

describe('nextRetryAt', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const schedule = [3600, 21600];

    it('follows the schedule then gives up', () => {
        expect(nextRetryAt('insufficient_funds', 1, t0, schedule)?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
        expect(nextRetryAt('insufficient_funds', 2, t0, schedule)?.toISOString()).toBe('2026-01-01T06:00:00.000Z');
        expect(nextRetryAt('insufficient_funds', 3, t0, schedule)).toBeNull();
    });

    it('never retries terminal failures', () => {
        expect(nextRetryAt('subscription_cancelled', 1, t0, schedule)).toBeNull();
    });
});
