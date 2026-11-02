import type { Logger } from 'pino';

import type { MetadataStatus, Repo } from '../db/repo.js';
import { MetadataFetchError } from './fetch.js';
import { classifyUri, normalizeMetadata, type PlanMetadata } from './schema.js';

export interface MetadataConfig {
    /** false: never fetch URLs (inline metadata is still read). */
    fetch: boolean;
    /** Re-fetch URL metadata this often; 0 never re-fetches an unchanged URI. */
    refreshSecs: number;
    /** Retry an unreachable URL (network error, timeout, 5xx) after this long. Invalid ones wait for refreshSecs. */
    retrySecs: number;
    /** At most this many URL fetches per pass (inline and empty URIs don't count). */
    maxFetchesPerPass: number;
}

export interface MetadataPassResult {
    resolved: number;
    fetched: number;
}

type Resolution = {
    status: MetadataStatus;
    source: 'inline' | 'url' | null;
    data: PlanMetadata | null;
    error: string | null;
};

function fromDocument(doc: unknown, source: 'inline' | 'url'): Resolution {
    const n = normalizeMetadata(doc);
    if (!n.ok) return { status: 'invalid', source, data: null, error: n.error };
    return { status: 'ok', source, data: n.data, error: n.warnings.length ? n.warnings.join('; ') : null };
}

/**
 * Resolves plan metadata for plans whose `metadataUri` is new or changed, refreshes URL metadata
 * periodically, and retries unreachable URLs. `fetchDocument` returns a document's body.
 */
export async function resolvePlanMetadata(deps: {
    repo: Repo;
    cfg: MetadataConfig;
    fetchDocument: (url: URL) => Promise<string>;
    log: Logger;
}): Promise<MetadataPassResult> {
    const { repo, cfg, fetchDocument, log } = deps;
    const result: MetadataPassResult = { resolved: 0, fetched: 0 };
    const seen = new Map<string, Promise<Resolution>>();
    const fetchAndParse = async (url: URL): Promise<Resolution> => {
        let body: string;
        try {
            body = await fetchDocument(url);
        } catch (err) {
            const kind = err instanceof MetadataFetchError ? err.kind : 'transient';
            const status = kind === 'unsupported' ? 'skipped' : kind === 'not_metadata' ? 'invalid' : 'unreachable';
            return { status, source: 'url', data: null, error: (err as Error).message };
        }
        let doc: unknown;
        try {
            doc = JSON.parse(body);
        } catch {
            return { status: 'invalid', source: 'url', data: null, error: 'response is not JSON' };
        }
        return fromDocument(doc, 'url');
    };

    for (const plan of await repo.listPlansForMetadata(cfg.refreshSecs, cfg.retrySecs)) {
        const uri = classifyUri(plan.metadataUri);
        let r: Resolution;
        switch (uri.kind) {
            case 'empty':
                r = { status: 'none', source: null, data: null, error: null };
                break;
            case 'opaque':
                r = { status: 'opaque', source: null, data: null, error: null };
                break;
            case 'inline':
                r = fromDocument(uri.value, 'inline');
                break;
            case 'url': {
                if (!cfg.fetch) {
                    r = { status: 'skipped', source: 'url', data: null, error: 'metadata fetching is disabled' };
                    break;
                }
                // Plans often share a URL; fetch each once per pass.
                let pending = seen.get(uri.url.href);
                if (!pending) {
                    if (result.fetched >= cfg.maxFetchesPerPass) continue;
                    result.fetched++;
                    pending = fetchAndParse(uri.url);
                    seen.set(uri.url.href, pending);
                }
                r = await pending;
                break;
            }
        }
        await repo.setPlanMetadata(plan.address, plan.metadataUri, r);
        result.resolved++;
        if (r.status !== 'ok' && r.status !== 'none' && r.status !== 'opaque') {
            log.debug({ plan: plan.address, status: r.status, error: r.error }, 'plan metadata not resolved');
        }
    }
    if (result.resolved) log.info(result, 'plan metadata pass');
    return result;
}
