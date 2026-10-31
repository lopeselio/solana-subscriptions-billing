import type {
    Chain,
    ChainPlan,
    ChainSubscription,
    ChargeRequest,
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
    private sigCounter = 0;

    constructor(readonly signerAddress: string | null) {}

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
    async charge(req: ChargeRequest, onSigned: (s: string) => Promise<void>) {
        const sig = `sig${++this.sigCounter}`;
        await onSigned(sig);
        this.sent.push(req);
        if (this.failNext) {
            const e = this.failNext;
            this.failNext = null;
            throw e;
        }
        const s = this.subs.get(req.subscription.address)!;
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
        if (pulled + req.amount > s.amount) throw new ChargeError('program_error', 'program error 400', sig);
        this.subs.set(s.address, { ...s, currentPeriodStartTs: periodStartTs, amountPulledInPeriod: pulled + req.amount });
        this.signatures.set(sig, { status: 'succeeded' });
        return sig;
    }
    async signatureOutcome(sig: string): Promise<SignatureOutcome> {
        return this.signatures.get(sig) ?? { status: 'unknown' };
    }
}
