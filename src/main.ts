import { mkdir } from 'node:fs/promises';

import { address } from '@solana/kit';
import pino from 'pino';

import { buildServer } from './api/server.js';
import { loadKeypairFile, SolanaChain } from './chain/solana.js';
import { loadConfig } from './config.js';
import { connect, migrate } from './db/db.js';
import { Repo } from './db/repo.js';
import { refreshEntitlements } from './indexer/entitlements.js';
import { ingestEvents } from './indexer/ingest.js';
import { syncOnce } from './indexer/sync.js';
import { checkMetadata } from './metadata/check.js';
import { fetchMetadataDocument, type FetchOptions } from './metadata/fetch.js';
import { resolvePlanMetadata } from './metadata/resolve.js';
import { deliverDueEvents, type WebhookConfig } from './webhooks/dispatcher.js';
import { generateSecret } from './webhooks/signature.js';
import { runChargeCycle } from './worker/charge.js';
import { LoopsModule } from './worker/loops.js';

const USAGE = `usage: billing <command>

  migrate   create/upgrade the database schema
  sync      sync plans + subscriptions, ingest program events, update entitlements,
            resolve plan metadata (once)
  charge    run one charge cycle (requires KEYPAIR_PATH)
  api       serve the HTTP API
  deliver   deliver due webhook events once (requires WEBHOOK_URL)
  run       sync + charge loops + webhook delivery + API
            (charging only with KEYPAIR_PATH, delivery only with WEBHOOK_URL)
  webhook-secret  print a new whsec_ signing secret
  metadata-check <file | url | inline JSON>
            validate plan metadata against schemas/plan-metadata.v1.json
`;
const COMMANDS = ['migrate', 'sync', 'charge', 'api', 'deliver', 'run', 'webhook-secret', 'metadata-check'];

async function main() {
    const cmd = process.argv[2];
    if (!cmd || !COMMANDS.includes(cmd)) {
        process.stderr.write(USAGE);
        process.exit(cmd ? 1 : 0);
    }
    if (cmd === 'webhook-secret') {
        process.stdout.write(generateSecret() + '\n');
        return;
    }

    const cfg = loadConfig();
    const log = pino({ level: cfg.LOG_LEVEL });
    const fetchOpts: FetchOptions = {
        timeoutMs: cfg.METADATA_TIMEOUT_MS,
        maxBytes: cfg.METADATA_MAX_BYTES,
        allowLocal: cfg.METADATA_ALLOW_LOCAL,
    };

    if (cmd === 'metadata-check') {
        const input = process.argv[3];
        if (!input) throw new Error('usage: billing metadata-check <file | url | inline JSON>');
        const report = await checkMetadata(input, fetchOpts);
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        process.exitCode = report.ok ? 0 : 1;
        return;
    }

    if (cfg.DATABASE_URL.startsWith('pglite:./')) await mkdir('.data', { recursive: true });
    const db = await connect(cfg.DATABASE_URL);
    await migrate(db);
    const repo = new Repo(db);
    if (cmd === 'migrate') {
        log.info('schema up to date');
        return db.close();
    }

    const webhookCfg: WebhookConfig | null = cfg.WEBHOOK_URL
        ? {
              url: cfg.WEBHOOK_URL,
              secrets: cfg.WEBHOOK_SECRET!,
              timeoutMs: cfg.WEBHOOK_TIMEOUT_MS,
              retryScheduleSecs: cfg.WEBHOOK_RETRY_SCHEDULE_SECS,
              batchSize: 20,
          }
        : null;
    const deliver = async () => {
        if (!webhookCfg) return;
        const res = await deliverDueEvents({ repo, cfg: webhookCfg, log });
        if (res.delivered || res.failed) log.info(res, 'webhook delivery pass');
    };
    if (cmd === 'deliver') {
        if (!webhookCfg) throw new Error('deliver requires WEBHOOK_URL');
        await deliver();
        return db.close();
    }

    const signer = cfg.KEYPAIR_PATH ? await loadKeypairFile(cfg.KEYPAIR_PATH) : undefined;
    const chain = new SolanaChain({
        rpcUrl: cfg.RPC_URL,
        wsUrl: cfg.RPC_WS_URL,
        programAddress: cfg.PROGRAM_ADDRESS ? address(cfg.PROGRAM_ADDRESS) : undefined,
        signer,
        computeUnitPriceMicroLamports: cfg.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
        ingestCommitment: cfg.INGEST_COMMITMENT,
    });
    if (signer) log.info({ signer: signer.address }, 'loaded signer');
    if (cfg.planScope === 'managed' && !signer) {
        throw new Error("PLAN_SCOPE=managed needs KEYPAIR_PATH; set PLAN_SCOPE to 'all' or plan addresses");
    }

    const workerCfg = {
        retryScheduleSecs: cfg.RETRY_SCHEDULE_SECS,
        pendingTimeoutSecs: cfg.PENDING_TIMEOUT_SECS,
        destinationOwner: cfg.DESTINATION_OWNER,
        maxChargesPerCycle: cfg.MAX_CHARGES_PER_CYCLE,
        dryRun: cfg.DRY_RUN,
        batchSize: cfg.CHARGE_BATCH_SIZE,
    };
    // Snapshot, then the event ledger (new plans first get a cursor), then an entitlement pass so
    // time-based changes are announced too.
    const sync = async () => {
        await syncOnce({ repo, chain, scope: cfg.planScope, log });
        if (cfg.INGEST_EVENTS) {
            await ingestEvents({
                repo,
                chain,
                scope: cfg.planScope,
                log,
                maxTransactions: cfg.INGEST_MAX_TX_PER_PASS,
                backfill: cfg.INGEST_BACKFILL,
            });
        }
        await refreshEntitlements({ repo, now: await chain.clusterTime(), graceSecs: cfg.GRACE_PERIOD_SECS, log });
        await resolvePlanMetadata({
            repo,
            cfg: {
                fetch: cfg.METADATA_FETCH,
                refreshSecs: cfg.METADATA_REFRESH_SECS,
                retrySecs: cfg.METADATA_RETRY_SECS,
                maxFetchesPerPass: cfg.METADATA_MAX_FETCHES_PER_PASS,
            },
            fetchDocument: url => fetchMetadataDocument(url, fetchOpts),
            log,
        });
    };
    const charge = () => runChargeCycle({ repo, chain, cfg: workerCfg, log });

    if (cmd === 'sync') {
        await sync();
        return db.close();
    }
    if (cmd === 'charge') {
        if (!signer) throw new Error('charge requires KEYPAIR_PATH');
        await sync();
        await charge();
        return db.close();
    }

    // The API (and, for `run`, the background loops) run as one NestJS app. Its shutdown hooks
    // stop the loops after their current iteration, close the HTTP server, then the database.
    const loops =
        cmd === 'run'
            ? LoopsModule.forRoot({
                  sync,
                  charge: signer ? charge : undefined,
                  deliver: webhookCfg ? deliver : undefined,
                  syncIntervalSecs: cfg.SYNC_INTERVAL_SECS,
                  chargeIntervalSecs: cfg.CHARGE_INTERVAL_SECS,
                  webhookIntervalSecs: cfg.WEBHOOK_INTERVAL_SECS,
                  log,
                  onShutdown: () => db.close(),
              })
            : null;
    if (webhookCfg && loops) log.info({ url: webhookCfg.url }, 'webhook delivery enabled');
    const server = await buildServer(
        { repo, apiKey: cfg.API_KEY, graceSecs: cfg.GRACE_PERIOD_SECS },
        { imports: loops ? [loops] : [] },
    );
    server.app.enableShutdownHooks();
    if (!loops) process.once('beforeExit', () => void db.close());
    await server.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
    log.info({ host: cfg.API_HOST, port: cfg.API_PORT }, 'api listening');
}

main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
});
