/**
 * Fetching hosted plan metadata. Anyone can create a plan, so `metadataUri` is untrusted input
 * that makes this server issue requests (SSRF). By default only https URLs on public addresses
 * are fetched: every address a hostname resolves to is checked inside the socket's own DNS lookup
 * (so a rebinding DNS server can't swap in a private address after the check), redirects are
 * re-checked, and responses are capped in size and time.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

export interface FetchOptions {
    timeoutMs: number;
    maxBytes: number;
    /** Allow http:// and private/loopback addresses (local development and tests only). */
    allowLocal: boolean;
    maxRedirects?: number;
}

/**
 * - unsupported: the URL is never fetched (scheme, credentials, non-public address)
 * - not_metadata: the server answered, but not with a metadata document (4xx, HTML, too large)
 * - transient: worth retrying soon (network, timeout, 5xx, 408, 429)
 */
export type FetchErrorKind = 'unsupported' | 'not_metadata' | 'transient';

export class MetadataFetchError extends Error {
    constructor(
        message: string,
        readonly kind: FetchErrorKind = 'transient',
    ) {
        super(message);
    }
}

const blocked = new BlockList();
for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local, including cloud metadata endpoints
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, broadcast
] as const) {
    blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96], // NAT64
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
] as const) {
    blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, and other addresses that aren't on the public internet. */
export function isNonPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return true;
    if (family === 4) return blocked.check(address, 'ipv4');
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:XXXX:XXXX) is judged by the IPv4 address it carries.
    // (A ::ffff:0:0/96 rule in BlockList would also match every plain IPv4 address.)
    const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(.+)$/i.exec(address)?.[1];
    if (mapped) {
        if (isIP(mapped) === 4) return blocked.check(mapped, 'ipv4');
        const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped);
        if (hex) {
            const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
            return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
        }
    }
    return blocked.check(address, 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, cb: LookupCallback): void {
    dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, addresses) => {
        if (err) return cb(err, '');
        const bad = addresses.find(a => isNonPublicAddress(a.address));
        if (bad) return cb(new MetadataFetchError(`${hostname} resolves to non-public address ${bad.address}`, 'unsupported'), '');
        if (addresses.length === 0) return cb(new MetadataFetchError(`${hostname} has no addresses`), '');
        if (options.all) return cb(null, addresses);
        cb(null, addresses[0]!.address, addresses[0]!.family);
    });
}

function checkUrl(url: URL, allowLocal: boolean): void {
    if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) {
        throw new MetadataFetchError(`unsupported scheme ${url.protocol} (only https is fetched)`, 'unsupported');
    }
    if (url.username || url.password) throw new MetadataFetchError('credentials in URL', 'unsupported');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Sockets skip DNS lookup for IP literals, so check them here.
    if (!allowLocal && isIP(host) && isNonPublicAddress(host)) {
        throw new MetadataFetchError(`non-public address ${host}`, 'unsupported');
    }
}

function getOnce(url: URL, opts: FetchOptions): Promise<{ status: number; location?: string; body: string }> {
    return new Promise((resolve, reject) => {
        const mod = url.protocol === 'https:' ? https : http;
        // Settle first, then tear down without an error so nothing is emitted unhandled.
        const fail = (err: Error) => {
            clearTimeout(deadline);
            reject(err);
            req.destroy();
        };
        const req = mod.get(
            url,
            {
                lookup: opts.allowLocal ? undefined : (guardedLookup as never),
                headers: { accept: 'application/json', 'user-agent': 'solana-subscriptions-billing' },
            },
            res => {
                const status = res.statusCode ?? 0;
                res.on('error', fail);
                if (status >= 300 && status < 400) {
                    res.resume();
                    clearTimeout(deadline);
                    return resolve({ status, location: res.headers.location, body: '' });
                }
                const type = res.headers['content-type'] ?? '';
                if (status === 200 && /html/i.test(type)) {
                    return fail(new MetadataFetchError(`not a JSON document (${type.split(';')[0]})`, 'not_metadata'));
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > opts.maxBytes) return fail(new MetadataFetchError(`response larger than ${opts.maxBytes} bytes`, 'not_metadata'));
                    chunks.push(c);
                });
                res.on('end', () => {
                    clearTimeout(deadline);
                    resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
                });
            },
        );
        req.on('error', fail);
        // One deadline for the whole exchange (a socket timeout would only cover idle time).
        const deadline = setTimeout(() => fail(new MetadataFetchError(`timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
    });
}

/** GETs a metadata document's body, following up to `maxRedirects` re-checked redirects. */
export async function fetchMetadataDocument(url: URL, opts: FetchOptions): Promise<string> {
    let current = url;
    for (let hop = 0; ; hop++) {
        checkUrl(current, opts.allowLocal);
        const res = await getOnce(current, opts);
        if (res.status >= 300 && res.status < 400) {
            if (!res.location) throw new MetadataFetchError(`HTTP ${res.status} without a location`, 'not_metadata');
            if (hop >= (opts.maxRedirects ?? 3)) throw new MetadataFetchError('too many redirects', 'not_metadata');
            current = new URL(res.location, current);
            continue;
        }
        if (res.status !== 200) {
            const retry = res.status >= 500 || res.status === 408 || res.status === 429;
            throw new MetadataFetchError(`HTTP ${res.status}`, retry ? 'transient' : 'not_metadata');
        }
        return res.body;
    }
}
