import { createHmac, randomBytes } from 'node:crypto';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com), so receivers can verify with
 * any of its libraries (`standardwebhooks`, `svix`, ...):
 *
 *   webhook-id:        event id, stable across retries (dedupe on it)
 *   webhook-timestamp: unix seconds of this delivery attempt
 *   webhook-signature: "v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>", space-separated
 *                      when several secrets are active (rotation)
 *
 * Secrets are `whsec_<base64 key>`.
 */
const PREFIX = 'whsec_';

export function generateSecret(): string {
    return PREFIX + randomBytes(32).toString('base64');
}

export function secretKey(secret: string): Buffer {
    const b64 = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('webhook secret is not base64');
    const key = Buffer.from(b64, 'base64');
    if (key.length < 24 || key.length > 64) throw new Error('webhook secret must decode to 24-64 bytes');
    return key;
}

export function sign(secrets: readonly string[], id: string, timestamp: number, body: string): string {
    const content = `${id}.${timestamp}.${body}`;
    return secrets.map(s => 'v1,' + createHmac('sha256', secretKey(s)).update(content).digest('base64')).join(' ');
}

export function signedHeaders(secrets: readonly string[], id: string, body: string, now = new Date()) {
    const timestamp = Math.floor(now.getTime() / 1000);
    return {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': sign(secrets, id, timestamp, body),
    };
}
