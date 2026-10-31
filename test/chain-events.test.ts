import { createHash } from 'node:crypto';

import { type Address, getAddressEncoder, getBase58Decoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { decodeEvent, EVENT_IX_TAG, extractEvents, type JsonTransaction } from '../src/chain/events.js';

const PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44';
const AUTHORITY = 'EvtAuth111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const ZERO = '11111111111111111111111111111111';

// Distinct, valid addresses: 32 bytes of n.
const a = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n)) as Address;

const le64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return b;
};
const key = (s: string) => Buffer.from(getAddressEncoder().encode(s as Address));
const event = (disc: number, ...fields: Buffer[]) =>
    Buffer.concat([Buffer.from(EVENT_IX_TAG), Buffer.from([disc]), ...fields]);

/** SubscriptionTransferEvent in `write_inner` order (program/src/events/subscription_transfer.rs). */
const transferBytes = event(
    2,
    key(a(1)), // subscription
    key(a(2)), // plan
    key(a(3)), // delegator
    key(a(4)), // mint
    le64(1_000_000n), // amount
    le64(1_700_000_000n), // period_start_ts
    le64(1_700_003_600n), // period_end_ts
    le64(1_000_000n), // amount_pulled_in_period
    key(a(5)), // receiver
    key(a(6)), // receiver_token_account
    key(a(7)), // puller
);

describe('decodeEvent', () => {
    it('uses the Anchor event tag the program emits', () => {
        // event_engine.rs: EVENT_IX_TAG = 0x1d9acb512ea545e4 (the big-endian reading of
        // sha256("anchor:event")[..8]), written on the wire as EVENT_IX_TAG.to_le_bytes().
        const sha = createHash('sha256').update('anchor:event').digest().subarray(0, 8);
        expect(sha.readBigUInt64BE()).toBe(0x1d9acb512ea545e4n);
        expect(Buffer.from(EVENT_IX_TAG).readBigUInt64LE()).toBe(0x1d9acb512ea545e4n);
        // codama discriminator on SubscriptionTransferEvent
        expect([...EVENT_IX_TAG]).toEqual([228, 69, 165, 46, 81, 203, 154, 29]);
    });

    it('decodes SubscriptionTransferEvent (256-byte payload)', () => {
        expect(transferBytes.length - 9).toBe(256);
        expect(decodeEvent(transferBytes)).toEqual({
            kind: 'subscription_transfer',
            subscription: a(1),
            plan: a(2),
            delegator: a(3),
            mint: a(4),
            amount: 1_000_000n,
            periodStartTs: 1_700_000_000n,
            periodEndTs: 1_700_003_600n,
            amountPulledInPeriod: 1_000_000n,
            receiver: a(5),
            receiverTokenAccount: a(6),
            puller: a(7),
        });
    });

    it('decodes the subscription lifecycle events', () => {
        expect(decodeEvent(event(0, key(a(2)), key(a(3)), key(a(4)), le64(42n), key(a(8))))).toEqual({
            kind: 'subscription_created',
            plan: a(2),
            subscriber: a(3),
            mint: a(4),
            createdTs: 42n,
            payer: a(8),
        });
        expect(decodeEvent(event(1, key(a(2)), key(a(3)), le64(99n)))).toEqual({
            kind: 'subscription_cancelled',
            plan: a(2),
            subscriber: a(3),
            expiresAtTs: 99n,
        });
        expect(decodeEvent(event(5, key(a(2)), key(a(3)), le64(7n)))).toEqual({
            kind: 'subscription_resumed',
            plan: a(2),
            subscriber: a(3),
            resumedTs: 7n,
        });
    });

    it('decodes PlanUpdatedEvent and drops unused (zero) puller slots', () => {
        const bytes = event(6, key(a(2)), key(a(9)), Buffer.from([1]), le64(0n), key(a(7)), key(ZERO), key(ZERO), key(ZERO));
        expect(bytes.length - 9).toBe(201);
        expect(decodeEvent(bytes)).toEqual({ kind: 'plan_updated', plan: a(2), owner: a(9), status: 1, endTs: 0n, pullers: [a(7)] });
    });

    it('accepts appended fields from newer program versions, rejects truncated or foreign data', () => {
        expect(decodeEvent(Buffer.concat([transferBytes, Buffer.alloc(8)]))?.kind).toBe('subscription_transfer');
        expect(decodeEvent(transferBytes.subarray(0, transferBytes.length - 1))).toBeNull();
        expect(decodeEvent(Buffer.concat([Buffer.alloc(8), transferBytes.subarray(8)]))).toBeNull(); // wrong tag
        expect(decodeEvent(event(3, Buffer.alloc(300)))).toBeNull(); // fixed delegation transfer: ignored
        expect(decodeEvent(event(42, Buffer.alloc(300)))).toBeNull();
    });
});

describe('extractEvents', () => {
    const data = getBase58Decoder().decode(transferBytes);
    // keys: 0 payer, 1 program, 2 event authority, 3 other program
    const tx = (inner: { programIdIndex: number; accounts: number[] }[], err: unknown = null): JsonTransaction => ({
        meta: { err, innerInstructions: [{ index: 0, instructions: inner.map(i => ({ ...i, data })) }] },
        transaction: { message: { accountKeys: [a(20), PROGRAM, AUTHORITY, OTHER] } },
    });

    it('returns events CPI-ed to the program and signed by the event authority', () => {
        expect(extractEvents(tx([{ programIdIndex: 1, accounts: [2] }]), PROGRAM, AUTHORITY)).toHaveLength(1);
    });

    it('ignores look-alikes: other programs, other signers, extra accounts, failed transactions', () => {
        expect(extractEvents(tx([{ programIdIndex: 3, accounts: [2] }]), PROGRAM, AUTHORITY)).toEqual([]);
        expect(extractEvents(tx([{ programIdIndex: 1, accounts: [0] }]), PROGRAM, AUTHORITY)).toEqual([]);
        expect(extractEvents(tx([{ programIdIndex: 1, accounts: [2, 0] }]), PROGRAM, AUTHORITY)).toEqual([]);
        expect(extractEvents(tx([{ programIdIndex: 1, accounts: [2] }], { InstructionError: [0, 'x'] }), PROGRAM, AUTHORITY)).toEqual([]);
    });

    it('resolves accounts loaded from address lookup tables', () => {
        const t: JsonTransaction = {
            meta: {
                err: null,
                innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [3], data }] }],
                loadedAddresses: { writable: [a(21)], readonly: [AUTHORITY] },
            },
            transaction: { message: { accountKeys: [a(20), PROGRAM] } },
        };
        expect(extractEvents(t, PROGRAM, AUTHORITY)).toHaveLength(1);
    });
});
