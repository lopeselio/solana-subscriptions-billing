/**
 * Plan metadata (schemas/plan-metadata.v1.json): classifying a plan's on-chain `metadataUri` and
 * normalizing the document it points to (or contains).
 *
 * The JSON Schema is the strict contract for publishers. Normalization here is lenient for
 * readers: a document with a valid name is accepted, and optional fields that fail validation are
 * dropped and reported as warnings, so one bad field doesn't hide a plan's name.
 */
import { z } from 'zod';

export const SCHEMA_URL =
    'https://raw.githubusercontent.com/lopeselio/solana-subscriptions-billing/main/schemas/plan-metadata.v1.json';

/** On-chain size of `metadataUri` (METADATA_URI_LEN in the program). */
export const METADATA_URI_BYTES = 128;

export interface PlanMetadata {
    name: string;
    description?: string;
    image?: string;
    icon?: string;
    externalUrl?: string;
    termsUrl?: string;
    supportUrl?: string;
    features?: string[];
    attributes?: Record<string, string | number | boolean>;
}

export type NormalizeResult =
    | { ok: true; data: PlanMetadata; warnings: string[] }
    | { ok: false; error: string };

export type UriKind =
    | { kind: 'empty' }
    | { kind: 'inline'; value: unknown }
    | { kind: 'url'; url: URL }
    | { kind: 'opaque' };

/** What a plan's `metadataUri` holds: nothing, inline JSON, a URL, or an app-specific tag. */
export function classifyUri(raw: string): UriKind {
    const s = raw.trim();
    if (!s) return { kind: 'empty' };
    if (s.startsWith('{')) {
        try {
            return { kind: 'inline', value: JSON.parse(s) };
        } catch {
            return { kind: 'opaque' };
        }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        try {
            return { kind: 'url', url: new URL(s) };
        } catch {
            return { kind: 'opaque' };
        }
    }
    return { kind: 'opaque' };
}

const text = (max: number) => z.string().trim().max(max);
const webUrl = z.string().max(512).regex(/^https?:\/\/\S+$/).pipe(z.url());
const assetUri = z.string().max(512).regex(/^(https:\/\/|ipfs:\/\/|ar:\/\/)\S+$/);
const scalar = z.union([z.string().max(512), z.number(), z.boolean()]);

const FIELDS = {
    description: text(1000),
    image: assetUri,
    icon: text(32),
    externalUrl: webUrl,
    termsUrl: webUrl,
    supportUrl: webUrl,
    features: z.array(z.string().trim().min(1).max(200)).max(32),
    attributes: z.record(z.string().max(64), scalar).refine(o => Object.keys(o).length <= 64, 'too many attributes'),
} satisfies Record<Exclude<keyof PlanMetadata, 'name'>, z.ZodType>;

const FULL_KEYS: Record<string, keyof PlanMetadata> = {
    name: 'name',
    description: 'description',
    image: 'image',
    icon: 'icon',
    external_url: 'externalUrl',
    terms_url: 'termsUrl',
    support_url: 'supportUrl',
    features: 'features',
    attributes: 'attributes',
};
const COMPACT_KEYS: Record<string, keyof PlanMetadata> = { n: 'name', d: 'description', i: 'icon', w: 'externalUrl' };

/** Normalizes a full or compact metadata document to camelCase fields. */
export function normalizeMetadata(doc: unknown): NormalizeResult {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ok: false, error: 'not a JSON object' };
    const o = doc as Record<string, unknown>;
    const compact = !('name' in o) && 'n' in o;
    const keys = compact ? COMPACT_KEYS : FULL_KEYS;

    const name = text(64).min(1).safeParse(o[compact ? 'n' : 'name']);
    if (!name.success) return { ok: false, error: `${compact ? 'n' : 'name'}: required, 1-64 characters` };

    const data: PlanMetadata = { name: name.data };
    const warnings: string[] = [];
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(o)) {
        const field = keys[key];
        if (field === 'name' || key === '$schema') continue;
        if (!field) {
            if (compact) extra[key] = value; // unknown compact keys are attributes (e.g. external price IDs)
            continue; // unknown full-document keys are ignored (forward compatible)
        }
        if (value === '' || value === null) continue;
        const parsed = FIELDS[field].safeParse(value);
        if (parsed.success) (data as unknown as Record<string, unknown>)[field] = parsed.data;
        else warnings.push(`${key}: ignored (${parsed.error.issues[0]?.message ?? 'invalid'})`);
    }
    if (Object.keys(extra).length > 0) {
        const attrs = FIELDS.attributes.safeParse(extra);
        if (attrs.success) data.attributes = attrs.data;
        else warnings.push(`attributes: ignored (${attrs.error.issues[0]?.message ?? 'invalid'})`);
    }
    return { ok: true, data, warnings };
}

/** The compact inline form of `data`, for putting straight into `metadataUri` (only n/d/i/w). */
export function toCompact(data: Pick<PlanMetadata, 'name' | 'description' | 'icon' | 'externalUrl'>): string {
    const c: Record<string, string> = { n: data.name };
    if (data.description) c.d = data.description;
    if (data.icon) c.i = data.icon;
    if (data.externalUrl) c.w = data.externalUrl;
    return JSON.stringify(c);
}
