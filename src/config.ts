import { z } from 'zod';

import { secretKey } from './webhooks/signature.js';

const csvNumbers = z
    .string()
    .transform(s => s.split(',').map(x => Number(x.trim())))
    .pipe(z.array(z.number().int().positive()));

const schema = z.object({
    DATABASE_URL: z.string().default('pglite:./.data/pglite'),
    RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
    /** Defaults to RPC_URL with http(s) -> ws(s). */
    RPC_WS_URL: z.string().url().optional(),
    /** Override for local deployments; defaults to the canonical program ID. */
    PROGRAM_ADDRESS: z.string().optional(),

    /** Solana CLI keypair JSON for the merchant or an approved puller. Omit for read-only (indexer + API). */
    KEYPAIR_PATH: z.string().optional(),
    /** 'managed' | 'all' | comma-separated plan addresses. */
    PLAN_SCOPE: z.string().default('managed'),
    DESTINATION_OWNER: z.string().optional(),

    SYNC_INTERVAL_SECS: z.coerce.number().int().positive().default(30),
    CHARGE_INTERVAL_SECS: z.coerce.number().int().positive().default(60),
    RETRY_SCHEDULE_SECS: csvNumbers.default([3600, 6 * 3600, 24 * 3600, 72 * 3600]),
    PENDING_TIMEOUT_SECS: z.coerce.number().int().positive().default(180),
    MAX_CHARGES_PER_CYCLE: z.coerce.number().int().positive().default(200),
    /** Charges per transaction for one plan. 4 is the most that fits (1232-byte limit); 1 disables. */
    CHARGE_BATCH_SIZE: z.coerce.number().int().min(1).max(16).default(4),
    COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: z.coerce.bigint().default(0n),
    DRY_RUN: z
        .enum(['true', 'false', '1', '0'])
        .default('false')
        .transform(v => v === 'true' || v === '1'),

    /** Read the program's events from transaction history into the payment ledger. */
    INGEST_EVENTS: z
        .enum(['true', 'false', '1', '0'])
        .default('true')
        .transform(v => v === 'true' || v === '1'),
    /** 'finalized' never records a transaction from a rolled-back fork; 'confirmed' is ~13s sooner. */
    INGEST_COMMITMENT: z.enum(['confirmed', 'finalized']).default('finalized'),
    INGEST_MAX_TX_PER_PASS: z.coerce.number().int().positive().default(500),
    /** Also load history from before tracking started into the ledger (not announced). */
    INGEST_BACKFILL: z
        .enum(['true', 'false', '1', '0'])
        .default('true')
        .transform(v => v === 'true' || v === '1'),

    GRACE_PERIOD_SECS: z.coerce.bigint().default(3n * 24n * 3600n),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().default(8787),
    API_KEY: z.string().min(16).optional(),
    LOG_LEVEL: z.string().default('info'),

    /** Endpoint that receives signed event POSTs. Events are recorded either way (GET /events). */
    WEBHOOK_URL: z.string().url().optional(),
    /** whsec_... signing secret(s), comma-separated during rotation; `billing webhook-secret` makes one. */
    WEBHOOK_SECRET: z
        .string()
        .transform(s => s.split(',').map(x => x.trim()).filter(Boolean))
        .refine(list => list.length > 0, 'at least one secret')
        .superRefine((list, ctx) => {
            for (const s of list) {
                try {
                    secretKey(s);
                } catch (err) {
                    ctx.addIssue({ code: 'custom', message: (err as Error).message });
                }
            }
        })
        .optional(),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    WEBHOOK_INTERVAL_SECS: z.coerce.number().int().positive().default(5),
    WEBHOOK_RETRY_SCHEDULE_SECS: csvNumbers.default([10, 60, 300, 1800, 7200, 21600, 43200, 86400]),
});

export type Config = z.infer<typeof schema> & { RPC_WS_URL: string; planScope: 'managed' | 'all' | string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const c = schema.parse(env);
    if (c.WEBHOOK_URL && !c.WEBHOOK_SECRET) throw new Error('WEBHOOK_URL is set but WEBHOOK_SECRET is not');
    const scope = c.PLAN_SCOPE === 'managed' || c.PLAN_SCOPE === 'all'
        ? c.PLAN_SCOPE
        : c.PLAN_SCOPE.split(',').map(s => s.trim()).filter(Boolean);
    return {
        ...c,
        RPC_WS_URL: c.RPC_WS_URL ?? c.RPC_URL.replace(/^http/, 'ws'),
        planScope: scope,
    };
}
