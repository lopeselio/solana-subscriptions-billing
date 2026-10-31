import type { FailureReason } from '../core/billing.js';
import type { PlanRecord, SubscriptionRecord } from '../db/repo.js';

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

/** A charge failed on-chain or in preflight. */
export class ChargeError extends Error {
    constructor(
        readonly reason: FailureReason,
        message: string,
        readonly signature?: string,
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
     * Sends a transferSubscription and waits for confirmation. `onSigned` runs before the
     * transaction is sent so the caller can persist the signature for crash recovery.
     */
    charge(req: ChargeRequest, onSigned: (signature: string) => Promise<void>): Promise<string>;
    signatureOutcome(signature: string): Promise<SignatureOutcome>;
}
