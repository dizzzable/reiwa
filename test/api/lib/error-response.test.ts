/**
 * Spec for sendSafeError — the route-level safe error responder.
 *
 * The whole point of this helper is that the upstream error body / internal
 * API path embedded in `UpstreamError.message` NEVER reaches the client.
 * These tests pin that guarantee.
 */
import { describe, expect, it, vi } from 'vitest';

import { sendSafeError } from '../../../src/api/lib/error-response.js';
import { UpstreamError } from '../../../src/core/errors/index.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('sendSafeError', () => {
  it('responds with the generic message + status, never the upstream body', () => {
    const res = fakeRes();
    const upstream = new UpstreamError(
      'POST',
      '/api/internal/payments/checkout',
      502,
      'gateway provider stack trace: secret-token-xyz',
    );

    sendSafeError(
      { log: { error: vi.fn() } } as never,
      res as never,
      upstream,
      500,
      'Failed to create checkout',
      'payments/checkout',
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to create checkout' });
    // The sensitive bits must not leak into the client response.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('api/internal');
    expect(serialised).not.toContain('secret-token-xyz');
    expect(serialised).not.toContain('provider');
  });

  it('logs the full detail server-side via the request logger', () => {
    const res = fakeRes();
    const error = vi.fn();
    const upstream = new UpstreamError('GET', '/api/internal/x', 404, 'not found detail');

    sendSafeError(
      { log: { error } } as never,
      res as never,
      upstream,
      404,
      'Not found',
      'x',
    );

    expect(error).toHaveBeenCalledTimes(1);
    const [ctx, msg] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('x failed');
    expect(ctx).toMatchObject({ upstreamStatus: 404 });
  });
});
