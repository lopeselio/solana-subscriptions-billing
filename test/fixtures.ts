import pino from 'pino';

import type { WorkerConfig } from '../src/worker/charge.js';
import type { FakeChain } from './fake-chain.js';

export const log = pino({ level: 'silent' });
export const HOUR = 3600n;
export const MERCHANT = 'Merchant1111111111111111111111111111111111';
export const PULLER = 'Puller11111111111111111111111111111111111111';
export const ALICE = 'Alice111111111111111111111111111111111111111';
export const PLAN = 'Plan1111111111111111111111111111111111111111';
export const SUB = 'SubA1111111111111111111111111111111111111111';
export const MINT = 'Mint1111111111111111111111111111111111111111';

export const cfg: WorkerConfig = {
    retryScheduleSecs: [60, 600],
    pendingTimeoutSecs: 180,
    maxChargesPerCycle: 100,
    dryRun: false,
};


export function seed(c: FakeChain) {
    c.plans.set(PLAN, {
        address: PLAN,
        owner: MERCHANT,
        planId: 1n,
        mint: MINT,
        amount: 500n,
        periodHours: 720n,
        termsCreatedAt: 1n,
        endTs: 0n,
        status: 1,
        destinations: [],
        pullers: [PULLER],
        metadataUri: 'https://example.com/plan.json',
    });
    c.subs.set(SUB, {
        address: SUB,
        plan: PLAN,
        subscriber: ALICE,
        payer: ALICE,
        amount: 500n,
        periodHours: 720n,
        termsCreatedAt: 1n,
        amountPulledInPeriod: 0n,
        currentPeriodStartTs: c.now,
        expiresAtTs: 0n,
    });
}
