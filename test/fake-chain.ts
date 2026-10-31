import type { Address } from '@solana/kit';

import type { ProgramEvent } from '../src/chain/events.js';
import type {
    Chain,
    ChainPlan,
    ChainSubscription,
    ChargeRequest,
    SignatureInfo,
    SignatureOutcome,
    SourceAccountState,
} from '../src/chain/types.js';
import { ChargeError } from '../src/chain/types.js';
import { effectivePeriod } from '../src/core/billing.js';

/** In-memory chain that applies the same accounting the program does on a successful charge. */
export class FakeChain implements Chain {
    now = 1_000_000n;
    plans = new Map<string, ChainPlan>();
    subs = new Map<string, ChainSubscription>();
    sources = new Map<string, SourceAccountState>();
    sent: ChargeRequest[] = [];
    signatures = new Map<string, SignatureOutcome>();
    /** Next charge throws this, once. */
    failNext: ChargeError | null = null;
    /** Transfers per charge transaction, in order. */
    batches: number[] = [];
    /** Largest batch that fits in a transaction; bigger ones fail before sending. */
    batchLimit = Infinity;
    /** Charges for these subscriptions fail on-chain with this error, at their instruction. */
    rejects = new Map<string, ChargeError>();
    /** Next charge lands on-chain but the client sees a confirmation timeout. */
    timeoutAfterLandingNext = false;
    /** Transaction history, oldest first, as getSignaturesForAddress would see it. */
    txs: (SignatureInfo & { addresses: string[]; events: ProgramEvent[] })[] = [];
    /** Signatures whose transaction getTransaction can't return yet. */
    unavailable = new Set<string>();
    readonly programAddress = 'Program1111111111111111111111111111111111111';
    private sigCounter = 0;

    constructor(readonly signerAddress: string | null) {}

    /** Appends a transaction touching the program, `addresses` and the plans/subscriptions in `events`. */
    record(events: ProgramEvent[], opts: { failed?: boolean; addresses?: string[] } = {}): string {
        const signature = `sig${++this.sigCounter}`;
        const touched = events.flatMap(e => ('subscription' in e ? [e.plan, e.subscription] : [e.plan]));
        this.txs.push({
            signature,
            slot: BigInt(this.txs.length + 1),
            blockTime: this.now,
            failed: opts.failed ?? false,
            addresses: [this.programAddress, ...touched, ...(opts.addresses ?? [])],
            events: opts.failed ? [] : events,
        });
        return signature;
    }

    /** A pull by someone other than the worker (e.g. the merchant or another puller). */
    externalPull(subscription: string, amount: bigint, puller: string): string {
        const transfer = this.applyPull(subscription, amount, puller);
        return this.record([transfer]);
    }

    private applyPull(subscription: string, amount: bigint, puller: string): ProgramEvent {
        const s = this.subs.get(subscription)!;
        const plan = this.plans.get(s.plan)!;
        const { periodStartTs, pulled } = effectivePeriod(
            {
                amountPerPeriod: s.amount,
                periodHours: s.periodHours,
                currentPeriodStartTs: s.currentPeriodStartTs,
                amountPulledInPeriod: s.amountPulledInPeriod,
                expiresAtTs: s.expiresAtTs,
            },
            plan.endTs,
            this.now,
        );
        if (pulled + amount > s.amount) throw new ChargeError('program_error', 'program error 400');
        this.subs.set(s.address, { ...s, currentPeriodStartTs: periodStartTs, amountPulledInPeriod: pulled + amount });
        const receiver = (plan.destinations[0] ?? plan.owner) as Address;
        return {
            kind: 'subscription_transfer',
            subscription: s.address as Address,
            plan: s.plan as Address,
            delegator: s.subscriber as Address,
            mint: plan.mint as Address,
            amount,
            periodStartTs,
            periodEndTs: periodStartTs + s.periodHours * 3600n,
            amountPulledInPeriod: pulled + amount,
            receiver,
            receiverTokenAccount: `ATA:${receiver}` as Address,
            puller: puller as Address,
        };
    }

    async signaturePage(
        address: string,
        opts: { before?: string; until?: string; limit: number },
    ): Promise<SignatureInfo[]> {
        const touching = this.txs.filter(t => t.addresses.includes(address));
        const pos = (sig?: string) => (sig === undefined ? -1 : touching.findIndex(t => t.signature === sig));
        const lo = opts.until === undefined ? 0 : pos(opts.until) + 1;
        const hi = opts.before === undefined ? touching.length : pos(opts.before);
        return touching
            .slice(lo, hi)
            .reverse()
            .slice(0, opts.limit)
            .map(({ signature, slot, blockTime, failed }) => ({ signature, slot, blockTime, failed }));
    }

    async subscriptionAddress(plan: string, subscriber: string): Promise<string> {
        const s = [...this.subs.values()].find(x => x.plan === plan && x.subscriber === subscriber);
        return s?.address ?? `Sub:${plan}:${subscriber}`;
    }

    async transactionEvents(signature: string): Promise<ProgramEvent[] | null> {
        if (this.unavailable.has(signature)) return null;
        return this.txs.find(t => t.signature === signature)?.events ?? null;
    }

    async clusterTime() {
        return this.now;
    }
    async fetchAllPlans() {
        return [...this.plans.values()];
    }
    async fetchSubscriptions(plans: string[]) {
        return new Map(plans.map(p => [p, [...this.subs.values()].filter(s => s.plan === p)]));
    }
    async subscriptionAuthorityAddress(subscriber: string, mint: string) {
        return `SA:${subscriber}:${mint}`;
    }
    async sourceAccountState(subscriber: string, mint: string) {
        return (
            this.sources.get(`${subscriber}:${mint}`) ?? {
                exists: true,
                amount: 10_000n,
                delegate: await this.subscriptionAuthorityAddress(subscriber, mint),
                delegatedAmount: 2n ** 64n - 1n,
            }
        );
    }
    async charge(reqs: readonly ChargeRequest[], onSigned: (s: string) => Promise<void>) {
        if (reqs.length > this.batchLimit) throw new ChargeError('transient', `batch of ${reqs.length} too large`);
        // The signature is known before sending, as with a real signed transaction.
        const sig = `sig${this.sigCounter + 1}`;
        await onSigned(sig);
        this.sent.push(...reqs);
        this.batches.push(reqs.length);
        const touched = reqs.map(r => r.subscription.address);
        const failTx = (e: ChargeError, index?: number) => {
            this.record([], { failed: true, addresses: touched });
            this.signatures.set(sig, { status: 'failed', error: e.message });
            return new ChargeError(e.reason, e.message, sig, index);
        };
        if (this.failNext) {
            const e = this.failNext;
            this.failNext = null;
            throw failTx(e);
        }
        const culprit = reqs.findIndex(r => this.rejects.has(r.subscription.address));
        if (culprit >= 0) throw failTx(this.rejects.get(reqs[culprit]!.subscription.address)!, culprit);

        // All or nothing, like a transaction.
        const saved = new Map(this.subs);
        const transfers: ProgramEvent[] = [];
        for (const [i, req] of reqs.entries()) {
            try {
                transfers.push(this.applyPull(req.subscription.address, req.amount, this.signerAddress!));
            } catch (err) {
                this.subs = saved;
                throw failTx(err as ChargeError, i);
            }
        }
        const recorded = this.record(transfers, { addresses: touched });
        if (recorded !== sig) throw new Error('fake chain signature drift');
        this.signatures.set(sig, { status: 'succeeded' });
        if (this.timeoutAfterLandingNext) {
            this.timeoutAfterLandingNext = false;
            throw new ChargeError('transient', 'confirmation timed out', sig);
        }
        return sig;
    }
    async signatureOutcome(sig: string): Promise<SignatureOutcome> {
        return this.signatures.get(sig) ?? { status: 'unknown' };
    }
}
