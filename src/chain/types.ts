import type { FailureReason } from '../core/billing.js';
import type { PlanRecord, SubscriptionRecord } from '../db/repo.js';
import type { ProgramEvent } from './events.js';

export type ChainPlan = Omit<PlanRecord, 'closed'>;
export type ChainSubscription = Omit<SubscriptionRecord, 'closed'>;

export interface SourceAccountState {
    exists: boolean;
    amount: bigint;
    delegate: string | null;
    delegatedAmount: bigint;
}

export interface ChargeRequest {
    plan: ChainPlan;
    subscription: ChainSubscription;
    amount: bigint;
    /** Wallet that receives funds; must be allowed by the plan's destination list. */
    destinationOwner: string;
}

export type SignatureOutcome = { status: 'succeeded' } | { status: 'failed'; error: string } | { status: 'unknown' };

export interface SignatureInfo {
    signature: string;
    slot: bigint;
    blockTime: bigint | null;
    /** The transaction failed; it carries no events. */
    failed: boolean;
}

/** A charge failed on-chain or in preflight. */
export class ChargeError extends Error {
    constructor(
        readonly reason: FailureReason,
        message: string,
        readonly signature?: string,
        /** For a batch: which request's instruction failed, when the error says. */
        readonly failedIndex?: number,
    ) {
        super(message);
    }
}

/**
 * Everything the indexer and worker need from Solana. The real implementation is
 * `SolanaChain`; tests use an in-memory fake.
 */
export interface Chain {
    /** Address of the signer the worker charges with, or null in read-only mode. */
    readonly signerAddress: string | null;
    /** Current cluster unix time (the program's Clock), in seconds. */
    clusterTime(): Promise<bigint>;
    fetchAllPlans(): Promise<ChainPlan[]>;
    /** Live subscriptions for the given plans, keyed by plan address (every plan present, possibly empty). */
    fetchSubscriptions(plans: string[]): Promise<Map<string, ChainSubscription[]>>;
    subscriptionAuthorityAddress(subscriber: string, mint: string): Promise<string>;
    sourceAccountState(subscriber: string, mint: string): Promise<SourceAccountState>;
    /**
     * Sends one transaction with a transferSubscription per request (all for the same plan and
     * destination) and waits for confirmation; all succeed or none do. `onSigned` runs before the
     * transaction is sent so the caller can persist the signature for crash recovery. A ChargeError
     * without a signature means nothing was sent (e.g. the batch doesn't fit in a transaction).
     */
    charge(reqs: readonly ChargeRequest[], onSigned: (signature: string) => Promise<void>): Promise<string>;
    signatureOutcome(signature: string): Promise<SignatureOutcome>;

    /** The subscriptions program address (the history source for program-wide ingestion). */
    readonly programAddress: string;
    /**
     * One page of signatures of transactions touching `address`, newest first, strictly between
     * `until` and `before` when given (getSignaturesForAddress semantics).
     */
    signaturePage(address: string, opts: { before?: string; until?: string; limit: number }): Promise<SignatureInfo[]>;
    /** The SubscriptionDelegation PDA for (plan, subscriber). */
    subscriptionAddress(plan: string, subscriber: string): Promise<string>;
    /** The program's events in a transaction, in order; null if the transaction isn't available yet. */
    transactionEvents(signature: string): Promise<ProgramEvent[] | null>;
}
