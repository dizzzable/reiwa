/**
 * Spec for the inbound rezeis-admin webhook signature verifier.
 *
 * The local `sign()` helper replicates rezeis-admin's `buildWebhookSignature`
 * (modules/webhooks/utils/signature.ts) byte-for-byte, so these tests prove
 * reiwa verifies exactly what the admin produces.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../../src/lib/webhook-signature.js';

const SECRET = 'a'.repeat(64); // admin WEBHOOK_SECRET_HEADER format

/** Mirror of admin's buildWebhookSignature: header `t=<sec>,v1=<hmac(`<t>.<body>`)>`. */
function sign(body: string, secret = SECRET, tSec = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac('sha256', secret).update(`${tSec}.${body}`).digest('hex');
  return `t=${tSec},v1=${hmac}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature produced by the admin scheme', () => {
    const body = JSON.stringify({ event: 'reiwa.bot.invalidate', metadata: { reason: 'save' } });
    expect(verifyWebhookSignature({ secret: SECRET, header: sign(body), body })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = '{"event":"x"}';
    const header = sign(body);
    expect(verifyWebhookSignature({ secret: SECRET, header, body: '{"event":"y"}' })).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const body = '{"event":"x"}';
    const header = sign(body, SECRET);
    expect(verifyWebhookSignature({ secret: 'b'.repeat(64), header, body })).toBe(false);
  });

  it('rejects a stale timestamp (outside ±5 min)', () => {
    const body = '{"event":"x"}';
    const staleT = Math.floor(Date.now() / 1000) - 10 * 60;
    const header = sign(body, SECRET, staleT);
    expect(verifyWebhookSignature({ secret: SECRET, header, body })).toBe(false);
  });

  it('honours a custom window with an injected clock', () => {
    const body = '{"event":"x"}';
    const tSec = 1_000_000_000;
    const header = sign(body, SECRET, tSec - 60); // 1 min old
    expect(
      verifyWebhookSignature({ secret: SECRET, header, body, nowSec: tSec, windowSec: 300 }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({ secret: SECRET, header, body, nowSec: tSec, windowSec: 30 }),
    ).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    const body = '{"event":"x"}';
    expect(verifyWebhookSignature({ secret: SECRET, header: undefined, body })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, header: 'garbage', body })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, header: 't=123', body })).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    const body = '{"event":"x"}';
    expect(verifyWebhookSignature({ secret: '', header: sign(body), body })).toBe(false);
  });
});
