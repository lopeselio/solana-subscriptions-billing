import type { Logger } from 'pino';

import type { ProgramEvent } from '../chain/events.js';
import type { Chain, SignatureInfo } from '../chain/types.js';
import type { ChainEventRecord, Repo } from '../db/repo.js';
import type { PlanScope } from './sync.js';

export interface IngestResult {
    transactions: number;
    events: number;
}

const stringify = (v: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'bigint' ? x.toString() : x]));

async function toRecord(
    chain: Chain,
    e: ProgramEvent,
    index: number,
    tx: SignatureInfo,
): Promise<{ record: ChainEventRecord; payment: Record<string, unknown> | null }> {
    const { kind, ...fields } = e;
    let subscription: string | null = null;
    let subscriber: string | null = null;
    if (e.kind === 'subscription_transfer') {
        subscription = e.subscription;
        subscriber = e.delegator;
    } else if (e.kind !== 'plan_updated') {
        subscriber = e.subscriber;
        subscription = await chain.subscriptionAddress(e.plan, e.subscriber);
    }
    const record: ChainEventRecord = {
        signature: tx.signature,
        eventIndex: index,
        slot: tx.slot,
        blockTime: tx.blockTime,
        kind,
        plan: e.plan,
        subscription,
        subscriber,
        data: stringify(fields),
    };
    const payment =
        e.kind === 'subscription_transfer'
            ? {
                  subscription: e.subscription,
                  plan: e.plan,
                  subscriber: e.delegator,
                  mint: e.mint,
                  amount: e.amount.toString(),
                  periodStartTs: e.periodStartTs.toString(),
                  periodEndTs: e.periodEndTs.toString(),
                  amountPulledInPeriod: e.amountPulledInPeriod.toString(),
                  receiver: e.receiver,
                  receiverTokenAccount: e.receiverTokenAccount,
                  puller: e.puller,
                  signature: tx.signature,
                  slot: tx.slot.toString(),
                  source: 'chain',
              }
            : null;
    return { record, payment };
}

const PAGE = 1000;
const DONE = 'done';

/**
 * Reads the program's events from transaction history into the `chain_events` ledger.
 *
 * Sources are each tracked plan's address history (or the program's, for PLAN_SCOPE=all).
 * Tracking a source starts at its newest transaction at the time it is first seen:
 *
 *  - Live: each pass reads transactions newer than the forward cursor, oldest first, and
 *    announces pulls not made by this worker as `payment.succeeded` (`source: 'chain'`). The
 *    cursor only moves past a fully stored transaction, so an interrupted pass resumes in order.
 *  - Backfill (optional): with whatever budget is left, walks older history backwards a page at a
 *    time into the ledger, without announcing it — a months-old pull is not news.
 *
 * Inserts are idempotent (signature + event index), so overlapping or repeated passes are safe.
 */
export async function ingestEvents(deps: {
    repo: Repo;
    chain: Chain;
    scope: PlanScope;
    log: Logger;
    /** Transactions to fetch per pass, across all sources. */
    maxTransactions?: number;
    /** Also walk history from before tracking started (ledger only). Default true. */
    backfill?: boolean;
}): Promise<IngestResult> {
    const { repo, chain, scope, log } = deps;
    const backfill = deps.backfill ?? true;
    let budget = deps.maxTransactions ?? 500;
    const result: IngestResult = { transactions: 0, events: 0 };

    const plans = await repo.listPlans();
    const sources = scope === 'all' ? [chain.programAddress] : plans.map(p => p.address);
    // Program-wide history includes other merchants' plans; keep only tracked ones.
    const tracked = scope === 'all' ? null : new Set(plans.map(p => p.address));

    /** Stores one transaction's events. False if the transaction isn't available yet. */
    const store = async (tx: SignatureInfo, announce: boolean): Promise<boolean> => {
        const events = tx.failed ? [] : await chain.transactionEvents(tx.signature);
        if (events === null) {
            log.debug({ signature: tx.signature }, 'transaction not available yet');
            return false;
        }
        for (const [i, e] of events.entries()) {
            if (tracked && !tracked.has(e.plan)) continue;
            const { record, payment } = await toRecord(chain, e, i, tx);
            if (await repo.insertChainEvent(record, announce ? payment : null)) result.events++;
        }
        result.transactions++;
        return true;
    };

    // Live first, for every source, so backfill never delays new payments.
    for (const source of sources) {
        const key = `ingest:${source}`;
        const cursor = await repo.getState(key);
        if (cursor === null) {
            const [newest] = await chain.signaturePage(source, { limit: 1 });
            if (!newest) continue; // no history yet
            if (backfill && !(await store(newest, false))) continue;
            await repo.setState(`ingest-backfill:${source}`, backfill ? newest.signature : DONE);
            await repo.setState(key, newest.signature);
            budget--;
            continue;
        }
        // Newer transactions arrive newest first; collect them all, then apply oldest first.
        const newer = [];
        for (let before: string | undefined; ; ) {
            const page = await chain.signaturePage(source, { until: cursor, before, limit: PAGE });
            newer.push(...page);
            if (page.length < PAGE) break;
            before = page[page.length - 1]!.signature;
        }
        for (const tx of newer.reverse()) {
            if (budget <= 0) break;
            budget--;
            if (!(await store(tx, true))) break;
            await repo.setState(key, tx.signature);
        }
    }

    for (const source of sources) {
        const key = `ingest-backfill:${source}`;
        let before = await repo.getState(key);
        while (before !== null && before !== DONE && budget > 0) {
            const limit = Math.min(budget, PAGE);
            const page = await chain.signaturePage(source, { before, limit });
            for (const tx of page) {
                budget--;
                if (!(await store(tx, false))) return finish();
                before = tx.signature;
                await repo.setState(key, before);
            }
            if (page.length < limit) {
                before = DONE;
                await repo.setState(key, DONE);
            }
        }
    }
    return finish();

    function finish() {
        if (result.transactions) log.info(result, 'ingested program events');
        return result;
    }
}
