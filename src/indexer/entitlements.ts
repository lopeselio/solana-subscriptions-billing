import type { Logger } from 'pino';

import { computeEntitlement, type Entitlement } from '../core/billing.js';
import type { Repo, SubscriptionRecord } from '../db/repo.js';

export function entitlementOf(sub: SubscriptionRecord, planEndTs: bigint, now: bigint, graceSecs: bigint) {
    if (sub.closed) return { status: 'closed', entitled: false, accessUntilTs: null } as const;
    return computeEntitlement(
        {
            amountPerPeriod: sub.amount,
            periodHours: sub.periodHours,
            currentPeriodStartTs: sub.currentPeriodStartTs,
            amountPulledInPeriod: sub.amountPulledInPeriod,
            expiresAtTs: sub.expiresAtTs,
        },
        { endTs: planEndTs },
        now,
        graceSecs,
    ) satisfies Entitlement;
}

/**
 * Entitlement changes with time as well as with chain state (grace runs out, a cancelled
 * subscription reaches expiresAt), so it is re-evaluated after each sync and every change is
 * announced once as `entitlement.changed`. `now` is cluster time, the clock the program uses.
 */
export async function refreshEntitlements(deps: {
    repo: Repo;
    now: bigint;
    graceSecs: bigint;
    log: Logger;
}): Promise<number> {
    const { repo, now, graceSecs, log } = deps;
    let changed = 0;
    for (const { sub, planEndTs, entitlementStatus } of await repo.listForEntitlement()) {
        const e = entitlementOf(sub, planEndTs, now, graceSecs);
        if (e.status === entitlementStatus) continue;
        if (await repo.setEntitlement(sub.address, entitlementStatus, e)) {
            changed++;
            log.debug({ subscription: sub.address, from: entitlementStatus, to: e.status }, 'entitlement changed');
        }
    }
    if (changed) log.info({ changed }, 'entitlements updated');
    return changed;
}
