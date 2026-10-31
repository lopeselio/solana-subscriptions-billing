/**
 * Decoder for the subscriptions program's self-CPI events (program/src/events/*.rs).
 *
 * The program emits each event by CPI-ing its own no-op `EmitEvent` instruction, signed by the
 * `event_authority` PDA, with data = 8-byte Anchor event tag ‖ 1-byte discriminator ‖ packed
 * little-endian fields. Only the program can sign for that PDA, so an inner instruction to the
 * program whose first account is the event authority is an authentic event.
 *
 * Layouts are those of program v0.4.0+ (deployed v0.5.0). New program versions append fields
 * without moving existing ones, so longer payloads are accepted and decoded by prefix.
 */
import {
    type Address,
    type Decoder,
    fixDecoderSize,
    getAddressDecoder,
    getArrayDecoder,
    getBase58Encoder,
    getI64Decoder,
    getStructDecoder,
    getU64Decoder,
    getU8Decoder,
} from '@solana/kit';

/** Sha256("anchor:event")[..8], i.e. 0x1d9acb512ea545e4 little-endian. */
export const EVENT_IX_TAG = new Uint8Array([228, 69, 165, 46, 81, 203, 154, 29]);

const ZERO_ADDRESS = '11111111111111111111111111111111';

export type ProgramEvent =
    | { kind: 'subscription_created'; plan: Address; subscriber: Address; mint: Address; createdTs: bigint; payer: Address }
    | { kind: 'subscription_cancelled'; plan: Address; subscriber: Address; expiresAtTs: bigint }
    | {
          kind: 'subscription_transfer';
          subscription: Address;
          plan: Address;
          /** The subscriber whose token account was debited. */
          delegator: Address;
          mint: Address;
          /** Gross amount debited (transfer-fee mints credit less). */
          amount: bigint;
          periodStartTs: bigint;
          periodEndTs: bigint;
          amountPulledInPeriod: bigint;
          receiver: Address;
          receiverTokenAccount: Address;
          puller: Address;
      }
    | { kind: 'subscription_resumed'; plan: Address; subscriber: Address; resumedTs: bigint }
    | { kind: 'plan_updated'; plan: Address; owner: Address; status: number; endTs: bigint; pullers: Address[] };

export type EventKind = ProgramEvent['kind'];

const addr = getAddressDecoder();
const u64 = getU64Decoder();
const i64 = getI64Decoder();

// Field order mirrors each event's `write_inner`. Discriminators 3 and 4 (fixed / recurring
// delegation transfers) are not plan-related and are ignored.
const LAYOUTS: Record<number, { kind: EventKind; decoder: Decoder<object> & { fixedSize: number } }> = {
    0: {
        kind: 'subscription_created',
        decoder: getStructDecoder([
            ['plan', addr],
            ['subscriber', addr],
            ['mint', addr],
            ['createdTs', i64],
            ['payer', addr],
        ]),
    },
    1: {
        kind: 'subscription_cancelled',
        decoder: getStructDecoder([
            ['plan', addr],
            ['subscriber', addr],
            ['expiresAtTs', i64],
        ]),
    },
    2: {
        kind: 'subscription_transfer',
        decoder: getStructDecoder([
            ['subscription', addr],
            ['plan', addr],
            ['delegator', addr],
            ['mint', addr],
            ['amount', u64],
            ['periodStartTs', i64],
            ['periodEndTs', i64],
            ['amountPulledInPeriod', u64],
            ['receiver', addr],
            ['receiverTokenAccount', addr],
            ['puller', addr],
        ]),
    },
    5: {
        kind: 'subscription_resumed',
        decoder: getStructDecoder([
            ['plan', addr],
            ['subscriber', addr],
            ['resumedTs', i64],
        ]),
    },
    6: {
        kind: 'plan_updated',
        decoder: getStructDecoder([
            ['plan', addr],
            ['owner', addr],
            ['status', getU8Decoder()],
            ['endTs', i64],
            ['pullers', fixDecoderSize(getArrayDecoder(addr, { size: 4 }), 128)],
        ]),
    },
};

/** Decodes one event instruction's data, or null if it is not a (known, plan-related) event. */
export function decodeEvent(data: Uint8Array): ProgramEvent | null {
    if (data.length < 9 || !EVENT_IX_TAG.every((b, i) => data[i] === b)) return null;
    const layout = LAYOUTS[data[8]!];
    if (!layout) return null;
    const payload = data.subarray(9);
    if (payload.length < layout.decoder.fixedSize) return null;
    const fields = layout.decoder.decode(payload.subarray(0, layout.decoder.fixedSize)) as Record<string, unknown>;
    if (layout.kind === 'plan_updated') {
        fields.pullers = (fields.pullers as Address[]).filter(p => p !== ZERO_ADDRESS);
    }
    return { kind: layout.kind, ...fields } as ProgramEvent;
}

/** The subset of a `getTransaction(…, { encoding: 'json' })` response the extractor reads. */
export interface JsonTransaction {
    meta: {
        err: unknown;
        innerInstructions?: readonly {
            index: number;
            instructions: readonly { programIdIndex: number; accounts: readonly number[]; data: string }[];
        }[] | null;
        loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
    } | null;
    transaction: { message: { accountKeys: readonly string[] } };
}

/**
 * Authentic program events in a transaction, in execution order. Failed transactions have
 * none (their inner instructions were rolled back).
 */
export function extractEvents(tx: JsonTransaction, programAddress: string, eventAuthority: string): ProgramEvent[] {
    if (!tx.meta || tx.meta.err) return [];
    // v0 transactions: static keys, then lookup-table writable, then readonly.
    const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const b58 = getBase58Encoder();
    const out: ProgramEvent[] = [];
    const groups = [...(tx.meta.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
    for (const group of groups) {
        for (const ix of group.instructions) {
            if (keys[ix.programIdIndex] !== programAddress) continue;
            if (ix.accounts.length !== 1 || keys[ix.accounts[0]!] !== eventAuthority) continue;
            const event = decodeEvent(new Uint8Array(b58.encode(ix.data)));
            if (event) out.push(event);
        }
    }
    return out;
}
