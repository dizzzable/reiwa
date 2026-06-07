/**
 * Spec for the internal-hop HMAC scheme used by the bot listener (and,
 * symmetrically, the admin → bot push channel).
 */
import { describe, expect, it } from 'vitest';

import {
  buildInternalSignature,
  verifyInternalSignature,
} from '../../src/lib/internal-hmac.js';

const SECRET = 'internal-shared-secret-at-least-32-chars-long';

describe('internal HMAC sign/verify', () => {
  it('round-trips a freshly signed request', () => {
    const body = JSON.stringify({ eventId: 'evt_1', telegramId: '42', text: 'hi' });
    const { timestamp, signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body,
    });
    expect(
      verifyInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: '/notify',
        body,
        timestamp,
        signature,
      }),
    ).toBe(true);
  });

  it('verifies an empty-body request (e.g. /invalidate)', () => {
    const { timestamp, signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/invalidate',
      body: '',
    });
    expect(
      verifyInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: '/invalidate',
        body: '',
        timestamp,
        signature,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { timestamp, signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body: '{"text":"original"}',
    });
    expect(
      verifyInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: '/notify',
        body: '{"text":"tampered"}',
        timestamp,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const body = '{"x":1}';
    const { timestamp, signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body,
    });
    expect(
      verifyInternalSignature({
        secret: 'a-different-secret',
        method: 'POST',
        path: '/notify',
        body,
        timestamp,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a path mismatch (signature is bound to the path)', () => {
    const body = '{"x":1}';
    const { timestamp, signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body,
    });
    expect(
      verifyInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: '/invalidate',
        body,
        timestamp,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp outside the freshness window', () => {
    const body = '{"x":1}';
    const staleTs = (Date.now() - 10 * 60 * 1000).toString(); // 10 min old
    const { signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body,
      timestamp: staleTs,
    });
    expect(
      verifyInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: '/notify',
        body,
        timestamp: staleTs,
        signature,
      }),
    ).toBe(false);
  });

  it('accepts a timestamp inside a custom window and rejects outside it', () => {
    const body = '{"x":1}';
    const now = 1_000_000_000_000;
    const ts = (now - 60_000).toString(); // 1 min old
    const { signature } = buildInternalSignature({
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body,
      timestamp: ts,
    });
    const base = {
      secret: SECRET,
      method: 'POST',
      path: '/notify',
      body,
      timestamp: ts,
      signature,
      now,
    } as const;
    expect(verifyInternalSignature({ ...base, windowMs: 5 * 60 * 1000 })).toBe(true);
    expect(verifyInternalSignature({ ...base, windowMs: 30 * 1000 })).toBe(false);
  });

  it('rejects missing timestamp or signature', () => {
    const body = '{"x":1}';
    const common = { secret: SECRET, method: 'POST', path: '/notify', body } as const;
    expect(
      verifyInternalSignature({ ...common, timestamp: undefined, signature: 'abc' }),
    ).toBe(false);
    expect(
      verifyInternalSignature({ ...common, timestamp: '123', signature: undefined }),
    ).toBe(false);
  });
});
