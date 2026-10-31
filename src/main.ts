import { mkdir } from 'node:fs/promises';

import { address } from '@solana/kit';
import pino from 'pino';

import { buildServer } from './api/server.js';
import { loadKeypairFile, SolanaChain } from './chain/solana.js';
import { loadConfig } from './config.js';
import { connect, migrate } from './db/db.js';
import { Repo } from './db/repo.js';
import { syncOnce } from './indexer/sync.js';
import { runChargeCycle } from './worker/charge.js';

const USAGE = `usage: billing <command>

  migrate   create/upgrade the database schema
  sync      sync plans + subscriptions once
  charge    run one charge cycle (requires KEYPAIR_PATH)
  api       serve the HTTP API
  run       sync + charge loops + API (charging only when KEYPAIR_PATH is set)
`;

async function main() {
    const cmd = process.argv[2];
    if (!cmd || !['migrate', 'sync', 'charge', 'api', 'run'].includes(cmd)) {
        process.stderr.write(USAGE);
        process.exit(cmd ? 1 : 0);
    }

    const cfg = loadConfig();
    const log = pino({ level: cfg.LOG_LEVEL });

    if (cfg.DATABASE_URL.startsWith('pglite:./')) await mkdir('.data', { recursive: true });
    const db = await connect(cfg.DATABASE_URL);
    await migrate(db);
    const repo = new Repo(db);
    if (cmd === 'migrate') {
        log.info('schema up to date');
        return db.close();
    }

    const signer = cfg.KEYPAIR_PATH ? await loadKeypairFile(cfg.KEYPAIR_PATH) : undefined;
    const chain = new SolanaChain({
        rpcUrl: cfg.RPC_URL,
        wsUrl: cfg.RPC_WS_URL,
        programAddress: cfg.PROGRAM_ADDRESS ? address(cfg.PROGRAM_ADDRESS) : undefined,
        signer,
        computeUnitPriceMicroLamports: cfg.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
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
    };
    const sync = () => syncOnce({ repo, chain, scope: cfg.planScope, log });
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

    const app = buildServer({ repo, apiKey: cfg.API_KEY, graceSecs: cfg.GRACE_PERIOD_SECS });
    await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
    log.info({ host: cfg.API_HOST, port: cfg.API_PORT }, 'api listening');
    if (cmd === 'api') return;

    // Sync and charge share one loop so a charge cycle always sees a fresh snapshot.
    let stopping = false;
    let lastCharge = 0;
    const loop = async () => {
        while (!stopping) {
            try {
                await sync();
                if (signer && Date.now() - lastCharge >= cfg.CHARGE_INTERVAL_SECS * 1000) {
                    lastCharge = Date.now();
                    await charge();
                }
            } catch (err) {
                log.error({ err }, 'loop iteration failed');
            }
            await new Promise(r => setTimeout(r, cfg.SYNC_INTERVAL_SECS * 1000));
        }
    };
    const done = loop();
    const shutdown = async () => {
        stopping = true;
        log.info('shutting down');
        await app.close();
        await done;
        await db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
});
