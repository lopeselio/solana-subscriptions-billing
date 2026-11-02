import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { connectPglite, type Db, migrate } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { syncOnce } from '../src/indexer/sync.js';
import { checkMetadata } from '../src/metadata/check.js';
import { fetchMetadataDocument, isNonPublicAddress, MetadataFetchError } from '../src/metadata/fetch.js';
import { type MetadataConfig, resolvePlanMetadata } from '../src/metadata/resolve.js';
import { classifyUri, normalizeMetadata } from '../src/metadata/schema.js';
import { FakeChain } from './fake-chain.js';
import { log, PLAN, PULLER, seed } from './fixtures.js';

const schema = JSON.parse(await readFile(new URL('../schemas/plan-metadata.v1.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true }).compile(schema);

describe('JSON Schema and engine agree', () => {
    it('the schema compiles in strict mode and accepts its own examples', () => {
        for (const ex of schema.examples) expect(validate(ex), JSON.stringify(validate.errors)).toBe(true);
    });

    // [document, valid per the schema, accepted by the engine]
    const cases: [string, unknown, boolean, boolean][] = [
        ['full document', schema.examples[0], true, true],
        ['compact (reference webapp)', schema.examples[1], true, true],
        ['compact with integration keys', { i: 'Star', n: 'Dedicated Node', sr: 'price_1', sp: 'prod_1' }, true, true],
        ['compact with empty description', { n: 'Launch', d: '' }, true, true],
        ['no name', { description: 'x' }, false, false],
        ['empty name', { name: '' }, false, false],
        ['65-character name', { name: 'x'.repeat(65) }, false, false],
        ['not an object', ['Pro'], false, false],
        ['website without a scheme', { n: 'Bot', w: 'tradingbot.example.com' }, false, true],
        ['http image', { name: 'Pro', image: 'http://example.com/a.png' }, false, true],
        ['33 features', { name: 'Pro', features: Array.from({ length: 33 }, (_, i) => `f${i}`) }, false, true],
        ['both name and n', { name: 'Pro', n: 'Other' }, false, true],
    ];
    it.each(cases)('%s', (_label, doc, schemaValid, engineOk) => {
        expect(validate(doc)).toBe(schemaValid);
        const n = normalizeMetadata(doc);
        expect(n.ok).toBe(engineOk);
        // Anything the schema accepts, the engine accepts in full.
        if (schemaValid && n.ok) expect(n.warnings).toEqual([]);
    });

    it('normalizes both forms to the same fields, dropping invalid optional ones with a warning', () => {
        expect(normalizeMetadata({ n: 'Pro', d: 'Fast', i: 'Star', w: 'https://x.io', sr: 'price_1' })).toEqual({
            ok: true,
            data: { name: 'Pro', description: 'Fast', icon: 'Star', externalUrl: 'https://x.io', attributes: { sr: 'price_1' } },
            warnings: [],
        });
        const full = normalizeMetadata({ name: 'Pro', external_url: 'https://x.io', terms_url: 'nope', future_field: 1 });
        expect(full).toMatchObject({ ok: true, data: { name: 'Pro', externalUrl: 'https://x.io' } });
        expect(full.ok && full.warnings).toEqual([expect.stringMatching(/^terms_url: ignored/)]);
        expect(full.ok && 'future_field' in full.data).toBe(false);
    });
});

describe('classifyUri', () => {
    it.each([
        ['', 'empty'],
        ['   ', 'empty'],
        ['{"n":"Pro"}', 'inline'],
        ['{not json', 'opaque'],
        ['https://example.com/plan.json', 'url'],
        ['ipfs://bafy', 'url'],
        ['pyron:vibetrader:monthly', 'opaque'],
        ['checkout-proof', 'opaque'],
    ])('%j is %s', (uri, kind) => {
        expect(classifyUri(uri).kind).toBe(kind);
    });
});

describe('fetching', () => {
    it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:10.0.0.1', '::ffff:a9fe:a9fe', 'nonsense'])(
        '%s is not public',
        a => expect(isNonPublicAddress(a)).toBe(true),
    );
    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', a => expect(isNonPublicAddress(a)).toBe(false));

    let server: Server;
    let base: string;
    beforeAll(async () => {
        server = createServer((req, res) => {
            const route: Record<string, () => void> = {
                '/plan.json': () => res.end(JSON.stringify({ name: 'Pro' })),
                '/missing': () => res.writeHead(404).end(),
                '/big': () => res.end('x'.repeat(2048)),
                '/slow': () => setTimeout(() => res.end('{}'), 2000),
                '/moved': () => res.writeHead(302, { location: '/plan.json' }).end(),
                '/loop': () => res.writeHead(302, { location: '/loop' }).end(),
                '/page': () => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html>'),
                '/down': () => res.writeHead(503).end(),
                '/busy': () => res.writeHead(429).end(),
                '/escape': () => res.writeHead(302, { location: 'file:///etc/passwd' }).end(),
            };
            (route[req.url!] ?? route['/missing']!)();
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => {
        server.closeAllConnections();
        server.close();
    });
    const local = { timeoutMs: 500, maxBytes: 1024, allowLocal: true };
    const strict = { ...local, allowLocal: false };

    it('refuses http, private IP literals, and hostnames that resolve to private addresses', async () => {
        const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as MetadataFetchError);
        expect(await err(fetchMetadataDocument(new URL(`${base}/plan.json`), strict))).toMatchObject({
            message: expect.stringMatching(/unsupported scheme http/),
            kind: 'unsupported',
        });
        expect(await err(fetchMetadataDocument(new URL('https://127.0.0.1/plan.json'), strict))).toMatchObject({
            kind: 'unsupported',
        });
        expect(await err(fetchMetadataDocument(new URL('https://[::1]/plan.json'), strict))).toMatchObject({
            kind: 'unsupported',
        });
        // Checked inside the socket's DNS lookup, so it holds for every connection attempt.
        expect(await err(fetchMetadataDocument(new URL('https://localhost/plan.json'), strict))).toMatchObject({
            message: expect.stringMatching(/localhost resolves to non-public address/),
            kind: 'unsupported',
        });
        expect((await err(fetchMetadataDocument(new URL('https://user:pw@example.com/'), strict)))?.kind).toBe('unsupported');
    });

    it('tells documents that are not metadata from failures worth retrying soon', async () => {
        const kind = (path: string) =>
            fetchMetadataDocument(new URL(`${base}${path}`), local).then(
                () => 'ok',
                (e: MetadataFetchError) => e.kind,
            );
        expect(await kind('/plan.json')).toBe('ok');
        expect(await kind('/page')).toBe('not_metadata'); // e.g. an SPA answering every path with HTML
        expect(await kind('/missing')).toBe('not_metadata');
        expect(await kind('/big')).toBe('not_metadata');
        expect(await kind('/loop')).toBe('not_metadata');
        expect(await kind('/down')).toBe('transient');
        expect(await kind('/busy')).toBe('transient');
        expect(await kind('/slow')).toBe('transient');
    });

    it('fetches, follows redirects, and caps size, time and hops', async () => {
        expect(await fetchMetadataDocument(new URL(`${base}/plan.json`), local)).toBe('{"name":"Pro"}');
        expect(await fetchMetadataDocument(new URL(`${base}/moved`), local)).toBe('{"name":"Pro"}');
        await expect(fetchMetadataDocument(new URL(`${base}/missing`), local)).rejects.toThrow('HTTP 404');
        await expect(fetchMetadataDocument(new URL(`${base}/big`), local)).rejects.toThrow(/larger than 1024 bytes/);
        await expect(fetchMetadataDocument(new URL(`${base}/slow`), local)).rejects.toThrow(/timed out/);
        await expect(fetchMetadataDocument(new URL(`${base}/loop`), local)).rejects.toThrow('too many redirects');
        // Every hop is checked, not only the first.
        await expect(fetchMetadataDocument(new URL(`${base}/escape`), local)).rejects.toThrow('unsupported scheme file:');
    });
});

describe('resolution pass', () => {
    let db: Db;
    let repo: Repo;
    let chain: FakeChain;
    let docs: Map<string, string | Error>;
    let fetched: string[];
    const cfg: MetadataConfig = { fetch: true, refreshSecs: 3600, retrySecs: 600, maxFetchesPerPass: 20 };
    const OTHER = 'Plan2222222222222222222222222222222222222222';

    beforeEach(async () => {
        db = await connectPglite();
        await migrate(db);
        repo = new Repo(db);
        chain = new FakeChain(PULLER);
        seed(chain);
        docs = new Map([['https://example.com/plan.json', JSON.stringify({ name: 'Pro', features: ['A', 'B'] })]]);
        fetched = [];
    });
    afterEach(async () => {
        await db.close();
    });

    const setUri = (plan: string, uri: string) => {
        if (!chain.plans.has(plan)) chain.plans.set(plan, { ...chain.plans.get(PLAN)!, address: plan, planId: BigInt(chain.plans.size + 1) });
        chain.plans.get(plan)!.metadataUri = uri;
    };
    const pass = async (c: Partial<MetadataConfig> = {}) => {
        await syncOnce({ repo, chain, scope: 'managed', log });
        return resolvePlanMetadata({
            repo,
            cfg: { ...cfg, ...c },
            log,
            fetchDocument: async url => {
                fetched.push(url.href);
                const d = docs.get(url.href);
                if (d === undefined) throw new MetadataFetchError('HTTP 404', 'not_metadata');
                if (d instanceof Error) throw d;
                return d;
            },
        });
    };
    const meta = async (plan = PLAN) => (await repo.getPlan(plan))!.metadata;
    const age = (secs: number) => db.query(`UPDATE plans SET metadata_checked_at = now() - make_interval(secs => $1)`, [secs]);

    it('fetches URL metadata once, and serves it on the plan', async () => {
        expect(await pass()).toEqual({ resolved: 1, fetched: 1 });
        expect(await meta()).toMatchObject({ status: 'ok', source: 'url', data: { name: 'Pro', features: ['A', 'B'] }, error: null });
        expect(await pass()).toEqual({ resolved: 0, fetched: 0 });

        const app = buildServer({ repo, graceSecs: 0n });
        const body = (await app.inject({ url: `/plans/${PLAN}` })).json();
        expect(body.metadata).toMatchObject({ status: 'ok', data: { name: 'Pro' } });
        expect((await app.inject({ url: '/plans' })).json()[0].metadata.data.name).toBe('Pro');
    });

    it('reads inline, empty and opaque URIs without fetching', async () => {
        setUri(PLAN, '{"n":"Launch","d":"","i":"Rocket","sr":"price_1"}');
        setUri(OTHER, 'pyron:vibetrader:monthly');
        await pass();
        expect(await meta()).toMatchObject({ status: 'ok', source: 'inline', data: { name: 'Launch', icon: 'Rocket', attributes: { sr: 'price_1' } } });
        expect((await meta(OTHER)).status).toBe('opaque');
        setUri(OTHER, '');
        await pass();
        expect((await meta(OTHER)).status).toBe('none');
        expect(fetched).toEqual([]);
    });

    it('re-resolves when the on-chain URI changes', async () => {
        await pass();
        docs.set('https://example.com/v2.json', JSON.stringify({ name: 'Pro v2' }));
        setUri(PLAN, 'https://example.com/v2.json');
        await pass();
        expect((await meta()).data?.name).toBe('Pro v2');
    });

    it('marks bad documents invalid, and URLs that are never fetched skipped', async () => {
        docs.set('https://example.com/plan.json', '<html>');
        await pass();
        expect(await meta()).toMatchObject({ status: 'invalid', error: 'response is not JSON', data: null });
        setUri(PLAN, '{"d":"no name"}');
        await pass();
        expect(await meta()).toMatchObject({ status: 'invalid', source: 'inline', error: expect.stringMatching(/^name: required/) });

        setUri(PLAN, 'ipfs://bafy');
        docs.set('ipfs://bafy', new MetadataFetchError('unsupported scheme ipfs:', 'unsupported'));
        await pass();
        expect((await meta()).status).toBe('skipped');
        await age(10_000);
        await pass();
        expect(fetched.filter(u => u === 'ipfs://bafy')).toHaveLength(1); // not retried
    });

    it('re-checks a URL that is not metadata daily (refreshSecs), not every retrySecs', async () => {
        docs.set('https://example.com/plan.json', new MetadataFetchError('not a JSON document (text/html)', 'not_metadata'));
        await pass();
        expect(await meta()).toMatchObject({ status: 'invalid', error: 'not a JSON document (text/html)' });
        await age(601);
        await pass();
        expect(fetched).toHaveLength(1);
        await age(3601);
        await pass();
        expect(fetched).toHaveLength(2);
    });

    it('fetches a URL shared by several plans once per pass', async () => {
        setUri(OTHER, 'https://example.com/plan.json');
        expect(await pass({ maxFetchesPerPass: 1 })).toEqual({ resolved: 2, fetched: 1 });
        expect((await meta(OTHER)).data?.name).toBe('Pro');
    });

    it('retries an unreachable URL after retrySecs', async () => {
        docs.set('https://example.com/plan.json', new MetadataFetchError('timed out after 5000ms'));
        await pass();
        expect(await meta()).toMatchObject({ status: 'unreachable', error: 'timed out after 5000ms' });
        await pass();
        expect(fetched).toHaveLength(1); // too soon

        docs.set('https://example.com/plan.json', JSON.stringify({ name: 'Pro' }));
        await age(601);
        await pass();
        expect(await meta()).toMatchObject({ status: 'ok', data: { name: 'Pro' }, error: null });
    });

    it('refreshes periodically, keeping the last good document if a refresh fails', async () => {
        await pass();
        docs.set('https://example.com/plan.json', JSON.stringify({ name: 'Pro (renamed)' }));
        await age(3601);
        await pass();
        expect((await meta()).data?.name).toBe('Pro (renamed)');

        docs.set('https://example.com/plan.json', new MetadataFetchError('HTTP 503'));
        await age(3601);
        await pass();
        expect(await meta()).toMatchObject({ status: 'ok', data: { name: 'Pro (renamed)' }, error: 'HTTP 503' });

        await age(3601);
        await pass({ refreshSecs: 0 }); // 0: only on URI change
        expect(fetched).toHaveLength(3);
    });

    it('fetches at most maxFetchesPerPass URLs, but resolves inline ones regardless', async () => {
        for (const p of ['Plan3333333333333333333333333333333333333333', 'Plan4444444444444444444444444444444444444444']) {
            setUri(p, `https://example.com/${p}.json`);
            docs.set(`https://example.com/${p}.json`, JSON.stringify({ name: p }));
        }
        setUri(OTHER, '{"n":"Inline"}');
        expect(await pass({ maxFetchesPerPass: 1 })).toEqual({ resolved: 2, fetched: 1 });
        expect(await pass({ maxFetchesPerPass: 1 })).toEqual({ resolved: 1, fetched: 1 });
        expect(await pass({ maxFetchesPerPass: 1 })).toEqual({ resolved: 1, fetched: 1 });
        expect(await pass({ maxFetchesPerPass: 1 })).toEqual({ resolved: 0, fetched: 0 });
    });

    it('does not fetch with fetching disabled', async () => {
        await pass({ fetch: false });
        expect(await meta()).toMatchObject({ status: 'skipped', error: 'metadata fetching is disabled' });
        expect(fetched).toEqual([]);
    });

    it('drops a result for a URI the plan no longer has', async () => {
        await pass();
        setUri(PLAN, '{"n":"New"}');
        await syncOnce({ repo, chain, scope: 'managed', log });
        await repo.setPlanMetadata(PLAN, 'https://example.com/plan.json', { status: 'ok', source: 'url', data: { name: 'Stale' }, error: null });
        expect((await meta()).data?.name).toBe('Pro');
    });
});

describe('metadata-check', () => {
    const opts = { timeoutMs: 500, maxBytes: 65536, allowLocal: false };

    it('checks inline values against the 128-byte field', async () => {
        expect(await checkMetadata('{"n":"Pro","i":"Star"}', opts)).toMatchObject({ ok: true, inlineBytes: 22 });
        const long = await checkMetadata(JSON.stringify({ n: 'Pro', d: 'x'.repeat(200) }), opts);
        expect(long).toMatchObject({ ok: false, error: expect.stringMatching(/^inline metadata is 218 bytes/) });
    });

    it('checks a file and suggests a compact inline equivalent', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'meta-'));
        const file = join(dir, 'plan.json');
        await writeFile(file, JSON.stringify(schema.examples[0]));
        const r = await checkMetadata(file, opts);
        expect(r).toMatchObject({ ok: true, warnings: [], data: { name: 'Pro', features: ['Unlimited API calls', 'Priority support', '99.9% SLA'] } });
        expect(JSON.parse(r.compact!)).toEqual({ n: 'Pro', d: 'Unlimited API calls and priority support.', w: 'https://example.com/pricing#pro' });
        expect((await checkMetadata(join(dir, 'missing.json'), opts)).ok).toBe(false);
    });
});
