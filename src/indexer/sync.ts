import type { Logger } from 'pino';

import type { Chain, ChainPlan } from '../chain/types.js';
import type { Repo } from '../db/repo.js';

/**
 * Which plans to track:
 *  - 'managed': plans the worker signer owns or may pull from (default when a signer is set)
 *  - 'all':     every plan on the program
 *  - string[]:  explicit plan addresses
 */
export type PlanScope = 'managed' | 'all' | string[];

export function canCharge(plan: Pick<ChainPlan, 'owner' | 'pullers'>, signer: string | null): boolean {
    return signer !== null && (plan.owner === signer || plan.pullers.includes(signer));
}

export function inScope(plan: ChainPlan, scope: PlanScope, signer: string | null): boolean {
    if (scope === 'all') return true;
    if (scope === 'managed') return canCharge(plan, signer);
    return scope.includes(plan.address);
}

export interface SyncResult {
    plans: number;
    subscriptions: number;
    plansClosed: number;
    subscriptionsClosed: number;
}

/** Snapshot sync: pulls current account state for tracked plans and their subscriptions. */
export async function syncOnce(deps: { repo: Repo; chain: Chain; scope: PlanScope; log: Logger }): Promise<SyncResult> {
    const { repo, chain, scope, log } = deps;
    const allPlans = await chain.fetchAllPlans();
    const tracked = allPlans.filter(p => inScope(p, scope, chain.signerAddress));

    const result: SyncResult = { plans: tracked.length, subscriptions: 0, plansClosed: 0, subscriptionsClosed: 0 };

    // fetchAllPlans returns every live plan, so anything stored but absent was deleted.
    result.plansClosed = await repo.markPlansClosedExcept(allPlans.map(p => p.address));

    const subsByPlan = await chain.fetchSubscriptions(tracked.map(p => p.address));
    for (const plan of tracked) {
        await repo.upsertPlan(plan);
        const subs = subsByPlan.get(plan.address) ?? [];
        for (const s of subs) await repo.upsertSubscription(s);
        result.subscriptions += subs.length;
        result.subscriptionsClosed += await repo.markSubscriptionsClosedExcept(
            plan.address,
            subs.map(s => s.address),
        );
    }

    log.info(result, 'sync complete');
    return result;
}
