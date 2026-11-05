import { timingSafeEqual } from 'node:crypto';

import {
    type ArgumentsHost,
    type CanActivate,
    Catch,
    type ExceptionFilter,
    type ExecutionContext,
    HttpException,
    Inject,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_OPTIONS, type ApiSettings } from './tokens.js';
import { json } from './views.js';

/** Validates a route's params or query with a zod schema; a ZodError becomes a 400 in ApiExceptionFilter. */
export class Zod<T extends z.ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
    constructor(private readonly schema: T) {}
    transform(value: unknown): z.infer<T> {
        return this.schema.parse(value);
    }
}

export class NotFound extends HttpException {
    constructor() {
        super({ error: 'not_found' }, 404);
    }
}

/**
 * Bearer-token check for every route except /health. Compared in constant time.
 * With no API_KEY configured the API is open (and should be bound to localhost).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    private readonly expected: Buffer | null;

    constructor(@Inject(API_OPTIONS) settings: ApiSettings) {
        this.expected = settings.apiKey ? Buffer.from(`Bearer ${settings.apiKey}`) : null;
    }

    canActivate(ctx: ExecutionContext): boolean {
        if (!this.expected) return true;
        const req = ctx.switchToHttp().getRequest<FastifyRequest>();
        if (req.url === '/health') return true;
        const got = Buffer.from(req.headers.authorization ?? '');
        if (got.length !== this.expected.length || !timingSafeEqual(got, this.expected)) {
            throw new HttpException({ error: 'unauthorized' }, 401);
        }
        return true;
    }
}

/**
 * Keeps the API's error bodies stable: 400 { error: 'bad_request', issues } for invalid input,
 * the exception's own body for HTTP errors (401, 404), and 500 { error: 'internal' } otherwise,
 * without leaking internals.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    catch(err: unknown, host: ArgumentsHost) {
        const reply = host.switchToHttp().getResponse<FastifyReply>();
        // Issues can carry bigints (e.g. a min(0n) bound), which JSON can't encode; send them as strings.
        if (err instanceof z.ZodError) return reply.code(400).send(json({ error: 'bad_request', issues: err.issues }));
        if (err instanceof HttpException) {
            const body = err.getResponse();
            return reply.code(err.getStatus()).send(typeof body === 'string' ? { error: body } : body);
        }
        return reply.code(500).send({ error: 'internal' });
    }
}
