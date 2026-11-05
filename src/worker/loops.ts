import {
    type BeforeApplicationShutdown,
    type DynamicModule,
    Inject,
    Injectable,
    Module,
    type OnApplicationBootstrap,
    type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';

export const LOOPS = Symbol('LOOPS');

export interface LoopOptions {
    /** Snapshot, ingest events, refresh entitlements, resolve metadata. */
    sync: () => Promise<void>;
    /** One charge cycle; omitted when there is no signer. */
    charge?: () => Promise<unknown>;
    /** One webhook delivery pass; omitted without WEBHOOK_URL. */
    deliver?: () => Promise<void>;
    syncIntervalSecs: number;
    chargeIntervalSecs: number;
    webhookIntervalSecs: number;
    log: Logger;
    /** Runs after the loops have stopped and the HTTP server has closed (e.g. close the database). */
    onShutdown?: () => Promise<void>;
}

/**
 * The background work, owned by the app's lifecycle:
 *  - sync and charge share one loop, so a charge cycle always sees a fresh snapshot;
 *  - webhook delivery has its own, shorter loop, so delivery latency doesn't depend on sync time.
 * On shutdown the current iteration finishes (a charge is never cut off halfway), the waits
 * between iterations are cut short, and only then is the database closed.
 */
@Injectable()
export class BillingLoops implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
    private stopping = false;
    private done: Promise<unknown> = Promise.resolve();
    private readonly waking = new Set<() => void>();

    constructor(@Inject(LOOPS) private readonly opts: LoopOptions) {}

    onApplicationBootstrap() {
        this.done = Promise.all([this.syncAndCharge(), this.delivery()]);
    }

    async beforeApplicationShutdown() {
        this.stopping = true;
        this.opts.log.info('shutting down');
        for (const wake of this.waking) wake();
        await this.done;
    }

    async onApplicationShutdown() {
        await this.opts.onShutdown?.();
    }

    /** Sleeps for `secs`, or until shutdown starts. */
    private sleep(secs: number) {
        return new Promise<void>(resolve => {
            const wake = () => {
                clearTimeout(timer);
                this.waking.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, secs * 1000);
            this.waking.add(wake);
        });
    }

    private async syncAndCharge() {
        let lastCharge = 0;
        while (!this.stopping) {
            try {
                await this.opts.sync();
                if (this.opts.charge && Date.now() - lastCharge >= this.opts.chargeIntervalSecs * 1000) {
                    lastCharge = Date.now();
                    await this.opts.charge();
                }
            } catch (err) {
                this.opts.log.error({ err }, 'loop iteration failed');
            }
            if (!this.stopping) await this.sleep(this.opts.syncIntervalSecs);
        }
    }

    private async delivery() {
        while (!this.stopping && this.opts.deliver) {
            try {
                await this.opts.deliver();
            } catch (err) {
                this.opts.log.error({ err }, 'webhook delivery pass failed');
            }
            if (!this.stopping) await this.sleep(this.opts.webhookIntervalSecs);
        }
    }
}

@Module({})
export class LoopsModule {
    static forRoot(opts: LoopOptions): DynamicModule {
        return { module: LoopsModule, providers: [{ provide: LOOPS, useValue: opts }, BillingLoops] };
    }
}
