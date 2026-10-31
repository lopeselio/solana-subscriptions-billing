import type { Logger } from 'pino';

import type { EventRecord, Repo } from '../db/repo.js';
import { signedHeaders } from './signature.js';

export interface WebhookConfig {
    url: string;
    /** Active signing secrets; the first is current, extras keep old receivers verifying during rotation. */
    secrets: readonly string[];
    timeoutMs: number;
    /** Waits after failed delivery 1, 2, ...; when exhausted the event is marked failed. */
    retryScheduleSecs: readonly number[];
    batchSize: number;
}

export interface DeliveryResult {
    delivered: number;
    failed: number;
}

/** The JSON body POSTed for an event. */
export function eventBody(e: EventRecord): string {
    return JSON.stringify({ id: e.eventId, type: e.type, timestamp: e.createdAt.toISOString(), data: e.data });
}

export function nextDeliveryAt(attempts: number, failedAt: Date, scheduleSecs: readonly number[]): Date | null {
    const wait = scheduleSecs[attempts - 1];
    return wait === undefined ? null : new Date(failedAt.getTime() + wait * 1000);
}

async function post(cfg: WebhookConfig, e: EventRecord, fetchImpl: typeof fetch): Promise<string | null> {
    const body = eventBody(e);
    try {
        const res = await fetchImpl(cfg.url, {
            method: 'POST',
            headers: { ...signedHeaders(cfg.secrets, e.eventId, body), 'user-agent': 'solana-subscriptions-billing' },
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (res.status >= 200 && res.status < 300) return null;
        const text = await res.text().catch(() => '');
        return `HTTP ${res.status}${text ? ': ' + text.slice(0, 500) : ''}`;
    } catch (err) {
        return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
}

/**
 * Delivers due events (oldest first) once each. At-least-once: a crash between POST and the
 * status update means a resend after the lease expires, so receivers should dedupe on webhook-id.
 */
export async function deliverDueEvents(deps: {
    repo: Repo;
    cfg: WebhookConfig;
    log: Logger;
    fetchImpl?: typeof fetch;
}): Promise<DeliveryResult> {
    const { repo, cfg, log } = deps;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const result: DeliveryResult = { delivered: 0, failed: 0 };
    // Sequential delivery: the lease must outlast a batch of timeouts.
    const leaseSecs = Math.ceil((cfg.batchSize * cfg.timeoutMs) / 1000) + 30;

    for (;;) {
        const events = await repo.claimDueEvents(cfg.batchSize, leaseSecs);
        if (events.length === 0) return result;
        for (const e of events) {
            const error = await post(cfg, e, fetchImpl);
            if (error === null) {
                await repo.markEventDelivered(e.id);
                result.delivered++;
                continue;
            }
            const next = nextDeliveryAt(e.deliveryAttempts, new Date(), cfg.retryScheduleSecs);
            await repo.markEventDeliveryFailed(e.id, error, next);
            result.failed++;
            log.warn(
                { event: e.eventId, type: e.type, attempt: e.deliveryAttempts, error, nextAt: next },
                next ? 'webhook delivery failed; will retry' : 'webhook delivery failed; giving up',
            );
        }
        if (events.length < cfg.batchSize) return result;
    }
}
