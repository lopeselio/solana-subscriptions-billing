import type { Logger } from 'pino';

import { type Chain, ChargeError } from '../chain/types.js';
import { computeChargeState, type FailureReason, nextRetryAt } from '../core/billing.js';
import type { ChargeAttempt, PlanRecord, Repo, SubscriptionRecord } from '../db/repo.js';
import { canCharge } from '../indexer/sync.js';

export interface WorkerConfig {
    /** Waits after failed attempt 1, 2, ... before retrying the same period. */
    retryScheduleSecs: readonly number[];
    /** A pending attempt older than this with no confirmed signature is treated as failed. */
    pendingTimeoutSecs: number;
    /** Preferred receiving wallet; used if the plan allows it. */
    destinationOwner?: string;
    maxChargesPerCycle: number;
    dryRun: boolean;
}

export interface CycleResult {
    charged: number;
    failed: number;
    skipped: number;
    reconciled: number;
    wouldCharge: number;
}

export function pickDestination(plan: PlanRecord, preferred?: string): string {
    if (plan.destinations.length === 0) return preferred ?? plan.owner;
    if (preferred && plan.destinations.includes(preferred)) return preferred;
    return plan.destinations[0]!;
}

/** Resolves attempts left pending by a crash or timeout. */
export async function reconcilePending(deps: { repo: Repo; chain: Chain; cfg: WorkerConfig; log: Logger }) {
    const { repo, chain, cfg, log } = deps;
    let reconciled = 0;
    for (const a of await repo.listPendingAttempts()) {
        const ageSecs = (Date.now() - a.updatedAt.getTime()) / 1000;
        if (a.signature) {
            const outcome = await chain.signatureOutcome(a.signature);
            if (outcome.status === 'succeeded') {
                await repo.succeedAttempt(a.id, a.signature);
                reconciled++;
                continue;
            }
            if (outcome.status === 'failed') {
                await fail(repo, a, 'program_error', outcome.error, cfg);
                reconciled++;
                continue;
            }
        }
        // Unknown or never signed: once the blockhash can no longer land, it is safe to retry.
        if (ageSecs > cfg.pendingTimeoutSecs) {
            await fail(repo, a, 'transient', 'pending attempt timed out without confirmation', cfg);
            log.warn({ attempt: a.id.toString(), signature: a.signature }, 'pending attempt timed out');
            reconciled++;
        }
    }
    return reconciled;
}

async function fail(repo: Repo, a: ChargeAttempt, reason: FailureReason, error: string, cfg: WorkerConfig) {
    await repo.failAttempt(a.id, reason, error, nextRetryAt(reason, a.attemptNo, new Date(), cfg.retryScheduleSecs));
}

/** Decides whether a period may be attempted now, given its latest attempt. */
export function mayAttempt(last: ChargeAttempt | null, now: Date): boolean {
    if (!last) return true;
    if (last.status !== 'failed') return false; // pending or succeeded
    return last.nextRetryAt !== null && last.nextRetryAt <= now;
}

export async function runChargeCycle(deps: {
    repo: Repo;
    chain: Chain;
    cfg: WorkerConfig;
    log: Logger;
}): Promise<CycleResult> {
    const { repo, chain, cfg, log } = deps;
    const result: CycleResult = { charged: 0, failed: 0, skipped: 0, reconciled: 0, wouldCharge: 0 };
    const signer = chain.signerAddress;
    if (!signer) throw new Error('worker requires a signer');

    result.reconciled = await reconcilePending(deps);

    const nowTs = await chain.clusterTime();
    const plans = (await repo.listPlans()).filter(p => canCharge(p, signer));

    let budget = cfg.maxChargesPerCycle;
    for (const plan of plans) {
        for (const sub of await repo.listSubscriptions({ plan: plan.address })) {
            if (budget <= 0) {
                log.warn('maxChargesPerCycle reached; remaining charges wait for the next cycle');
                return result;
            }
            const outcome = await processSubscription({ ...deps, plan, sub, nowTs });
            result[outcome]++;
            if (outcome === 'charged' || outcome === 'failed' || outcome === 'wouldCharge') budget--;
        }
    }
    log.info(result, 'charge cycle complete');
    return result;
}

async function processSubscription(deps: {
    repo: Repo;
    chain: Chain;
    cfg: WorkerConfig;
    log: Logger;
    plan: PlanRecord;
    sub: SubscriptionRecord;
    nowTs: bigint;
}): Promise<'charged' | 'failed' | 'skipped' | 'wouldCharge'> {
    const { repo, chain, cfg, plan, sub, nowTs } = deps;
    const log = deps.log.child({ subscription: sub.address, plan: plan.address });

    const state = computeChargeState(
        {
            amountPerPeriod: sub.amount,
            periodHours: sub.periodHours,
            currentPeriodStartTs: sub.currentPeriodStartTs,
            amountPulledInPeriod: sub.amountPulledInPeriod,
            expiresAtTs: sub.expiresAtTs,
        },
        { endTs: plan.endTs },
        nowTs,
    );
    if (state.kind !== 'due') return 'skipped';

    const last = await repo.lastAttempt(sub.address, state.periodStartTs);
    if (!mayAttempt(last, new Date())) return 'skipped';

    if (cfg.dryRun) {
        log.info({ amount: state.amount.toString(), periodStartTs: state.periodStartTs.toString() }, 'dry run: due');
        return 'wouldCharge';
    }

    const attempt = await repo.beginAttempt({
        subscription: sub.address,
        plan: plan.address,
        periodStartTs: state.periodStartTs,
        amount: state.amount,
    });
    if (!attempt) return 'skipped'; // another worker got there first

    // Preflight off-chain so predictable failures don't cost a transaction fee.
    const source = await chain.sourceAccountState(sub.subscriber, plan.mint);
    const authority = await chain.subscriptionAuthorityAddress(sub.subscriber, plan.mint);
    let preflight: [FailureReason, string] | null = null;
    if (!source.exists) preflight = ['source_account_missing', 'subscriber token account does not exist'];
    else if (source.delegate !== authority || source.delegatedAmount < state.amount)
        preflight = ['delegate_revoked', 'subscription authority is no longer the delegate on the source account'];
    else if (source.amount < state.amount)
        preflight = ['insufficient_funds', `balance ${source.amount} < ${state.amount}`];

    if (preflight) {
        await fail(repo, attempt, preflight[0], preflight[1], cfg);
        log.warn({ reason: preflight[0], attempt: attempt.attemptNo }, 'charge preflight failed');
        return 'failed';
    }

    try {
        const signature = await chain.charge(
            { plan, subscription: sub, amount: state.amount, destinationOwner: pickDestination(plan, cfg.destinationOwner) },
            sig => repo.setAttemptSignature(attempt.id, sig),
        );
        await repo.succeedAttempt(attempt.id, signature);
        log.info({ signature, amount: state.amount.toString() }, 'charged');
        return 'charged';
    } catch (err) {
        const ce = err instanceof ChargeError ? err : new ChargeError('transient', String(err));
        await fail(repo, attempt, ce.reason, ce.message, cfg);
        log.warn({ reason: ce.reason, error: ce.message, attempt: attempt.attemptNo }, 'charge failed');
        return 'failed';
    }
}
