import { readFile } from 'node:fs/promises';

import { fetchMetadataDocument, type FetchOptions } from './fetch.js';
import { METADATA_URI_BYTES, normalizeMetadata, type PlanMetadata, toCompact } from './schema.js';

export interface CheckReport {
    ok: boolean;
    error?: string;
    data?: PlanMetadata;
    warnings: string[];
    /** Byte length of the inline value, when the input is meant to go straight into metadataUri. */
    inlineBytes?: number;
    /** A compact inline equivalent (n/d/i/w) that fits in metadataUri, if one does. */
    compact?: string;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Validates metadata given as inline JSON, an https URL, or a local file path. */
export async function checkMetadata(input: string, fetchOpts: FetchOptions): Promise<CheckReport> {
    const trimmed = input.trim();
    const inline = trimmed.startsWith('{');
    let body: string;
    try {
        if (inline) body = trimmed;
        else if (/^https?:\/\//i.test(trimmed)) {
            if (bytes(trimmed) > METADATA_URI_BYTES) {
                return { ok: false, error: `URL is ${bytes(trimmed)} bytes; metadataUri holds ${METADATA_URI_BYTES}`, warnings: [] };
            }
            body = await fetchMetadataDocument(new URL(trimmed), fetchOpts);
        } else body = await readFile(trimmed, 'utf8');
    } catch (err) {
        return { ok: false, error: (err as Error).message, warnings: [] };
    }

    let doc: unknown;
    try {
        doc = JSON.parse(body);
    } catch {
        return { ok: false, error: 'not valid JSON', warnings: [] };
    }
    const n = normalizeMetadata(doc);
    if (!n.ok) return { ok: false, error: n.error, warnings: [] };

    const report: CheckReport = { ok: true, data: n.data, warnings: [...n.warnings] };
    if (inline) {
        report.inlineBytes = bytes(trimmed);
        if (report.inlineBytes > METADATA_URI_BYTES) {
            report.ok = false;
            report.error = `inline metadata is ${report.inlineBytes} bytes; metadataUri holds ${METADATA_URI_BYTES}`;
        }
    }
    const compact = toCompact(n.data);
    if (bytes(compact) <= METADATA_URI_BYTES) report.compact = compact;
    return report;
}
