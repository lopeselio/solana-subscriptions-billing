import 'reflect-metadata';

import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';

import { CONTROLLERS } from './controllers.js';
import { ApiExceptionFilter, ApiKeyGuard } from './http.js';
import { API_OPTIONS, type ApiOptions, type ApiSettings, REPO } from './tokens.js';

export type { ApiOptions } from './tokens.js';

/** The HTTP API: controllers, the bearer-token guard and the error filter. */
@Module({})
export class ApiModule {
    static forRoot(opts: ApiOptions): DynamicModule {
        const settings: ApiSettings = {
            apiKey: opts.apiKey,
            graceSecs: opts.graceSecs,
            now: opts.now ?? (() => BigInt(Math.floor(Date.now() / 1000))),
        };
        return {
            module: ApiModule,
            controllers: CONTROLLERS,
            providers: [
                { provide: REPO, useValue: opts.repo },
                { provide: API_OPTIONS, useValue: settings },
                { provide: APP_GUARD, useClass: ApiKeyGuard },
                { provide: APP_FILTER, useClass: ApiExceptionFilter },
            ],
        };
    }
}

@Module({})
class AppModule {}

export interface Server {
    app: NestFastifyApplication;
    /** Fastify's light-my-request injection, for tests. */
    inject: FastifyInstance['inject'];
    listen(opts: { host: string; port: number }): Promise<void>;
    close(): Promise<void>;
}

/**
 * Builds the API as a NestJS app on the Fastify adapter. Extra modules (for example the
 * background billing loops) share the app's lifecycle, so they start on boot and stop
 * cleanly on shutdown.
 */
export async function buildServer(opts: ApiOptions, extra: { imports?: DynamicModule[] } = {}): Promise<Server> {
    const root: DynamicModule = { module: AppModule, imports: [ApiModule.forRoot(opts), ...(extra.imports ?? [])] };
    const app = await NestFactory.create<NestFastifyApplication>(root, new FastifyAdapter(), { logger: false });
    await app.init();
    const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    return {
        app,
        inject: fastify.inject.bind(fastify) as FastifyInstance['inject'],
        listen: async ({ host, port }) => {
            await app.listen(port, host);
        },
        close: () => app.close(),
    };
}
