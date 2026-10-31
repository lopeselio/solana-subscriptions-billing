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
    /** Charges per transaction, for subscriptions of the same plan and destination. 1 = no batching. */
    batchSize?: number;
}

export interface CycleResult {
    charged: number;
    failed: number;
    skipped: number;
    reconciled: number;
    wouldCharge: number;
    /** Sent, but confirmation failed; left pending for reconciliation from the signature. */
    unconfirmed: number;
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

/** A due charge that passed preflight and has a pending attempt. */
interface Prepared {
    plan: PlanRecord;
    sub: SubscriptionRecord;
    attempt: ChargeAttempt;
    amount: bigint;
    destination: string;
}

type Deps = { repo: Repo; chain: Chain; cfg: WorkerConfig; log: Logger };

export async function runChargeCycle(deps: Deps): Promise<CycleResult> {
    const { repo, chain, cfg, log } = deps;
    const result: CycleResult = { charged: 0, failed: 0, skipped: 0, reconciled: 0, wouldCharge: 0, unconfirmed: 0 };
    const signer = chain.signerAddress;
    if (!signer) throw new Error('worker requires a signer');

    result.reconciled = await reconcilePending(deps);

    const nowTs = await chain.clusterTime();
    const plans = (await repo.listPlans()).filter(p => canCharge(p, signer));

    // 1. Decide and preflight every due subscription, within the cycle budget.
    const ready: Prepared[] = [];
    let budget = cfg.maxChargesPerCycle;
    collect: for (const plan of plans) {
        for (const sub of await repo.listSubscriptions({ plan: plan.address })) {
            if (budget <= 0) {
                log.warn('maxChargesPerCycle reached; remaining charges wait for the next cycle');
                break collect;
            }
            const outcome = await prepare({ ...deps, plan, sub, nowTs });
            if (typeof outcome === 'string') result[outcome]++;
            else ready.push(outcome);
            if (outcome !== 'skipped') budget--;
        }
    }

    // 2. Send, batching charges that share a plan and destination (they share most accounts).
    const groups = new Map<string, Prepared[]>();
    for (const p of ready) {
        const key = `${p.plan.address}|${p.destination}`;
        groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const size = Math.max(1, cfg.batchSize ?? 1);
    for (const group of groups.values()) {
        for (let i = 0; i < group.length; i += size) {
            await send(deps, group.slice(i, i + size), result);
        }
    }
    log.info(result, 'charge cycle complete');
    return result;
}

async function prepare(
    deps: Deps & { plan: PlanRecord; sub: SubscriptionRecord; nowTs: bigint },
): Promise<'failed' | 'skipped' | 'wouldCharge' | Prepared> {
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

    // Preflight off-chain so predictable failures don't cost a transaction fee (or sink a batch).
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
    return { plan, sub, attempt, amount: state.amount, destination: pickDestination(plan, cfg.destinationOwner) };
}

/**
 * Sends one transaction for `batch`. If a batch fails, the request the error points to is
 * failed and the rest are retried one per transaction; if nothing was sent (e.g. too large),
 * all are retried singly. An unknown outcome after sending leaves the attempts pending for
 * reconciliation.
 */
async function send(deps: Deps, batch: Prepared[], result: CycleResult): Promise<void> {
    const { repo, chain, cfg } = deps;
    const log = deps.log.child({ plan: batch[0]!.plan.address, batch: batch.length });
    try {
        const signature = await chain.charge(
            batch.map(p => ({ plan: p.plan, subscription: p.sub, amount: p.amount, destinationOwner: p.destination })),
            sig => Promise.all(batch.map(p => repo.setAttemptSignature(p.attempt.id, sig))).then(() => undefined),
        );
        for (const p of batch) await repo.succeedAttempt(p.attempt.id, signature);
        result.charged += batch.length;
        log.info({ signature, subscriptions: batch.map(p => p.sub.address) }, 'charged');
    } catch (err) {
        const ce = err instanceof ChargeError ? err : new ChargeError('transient', String(err));
        if (ce.reason === 'transient' && ce.signature) {
            // e.g. a confirmation timeout: the transaction may still land. Failing the attempts now
            // would record money that moved as unpaid; reconcilePending settles them from the signature.
            log.warn({ signature: ce.signature, error: ce.message }, 'charge outcome unknown; will reconcile');
            result.unconfirmed += batch.length;
            return;
        }
        if (batch.length === 1) {
            const [p] = batch as [Prepared];
            await fail(repo, p.attempt, ce.reason, ce.message, cfg);
            result.failed++;
            log.warn({ subscription: p.sub.address, reason: ce.reason, error: ce.message }, 'charge failed');
            return;
        }
        let rest = batch;
        if (ce.failedIndex !== undefined && batch[ce.failedIndex]) {
            const culprit = batch[ce.failedIndex]!;
            await fail(repo, culprit.attempt, ce.reason, ce.message, cfg);
            result.failed++;
            log.warn({ subscription: culprit.sub.address, reason: ce.reason }, 'charge failed; batch retried singly');
            rest = batch.filter(p => p !== culprit);
        } else {
            log.warn({ error: ce.message }, 'batch failed; retrying singly');
        }
        for (const p of rest) await send(deps, [p], result);
    }
}
