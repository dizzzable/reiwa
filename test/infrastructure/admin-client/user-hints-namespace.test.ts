import { describe, expect, it, vi } from 'vitest';

import {
  HINT_MODES_HEADER,
  UserHintsNamespace,
} from '../../../src/infrastructure/admin-client/namespaces/user-hints.js';

/**
 * THE DRAWABLE MODES TRAVEL IN A HEADER. THE BODY IS THE AUDIENCE, AND ONLY IT.
 *
 * The panel validates request bodies with a global `ValidationPipe` configured
 * `forbidNonWhitelisted: true`. A field its DTO has not learned is therefore not
 * IGNORED — it is a 400. And `src/api/routes/user-hints.ts` answers a failed
 * upstream call with `{ hint: null }`, logged at debug: a cabinet released ahead
 * of its panel would show nobody a single hint, with nothing anywhere saying
 * why. A header an old panel has never heard of is simply not read, which is the
 * only shape of this negotiation that survives being deployed in either order.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * Nothing watched the one line that decides it. `hint-modes-are-declared.ts`
 * reads the TEXT of the route, one call site up; `api/user-hints-route.test.ts`
 * stubs the namespace as `next(input) => …` and so captures only the first
 * argument. This mutation was green under both:
 *
 *     next(input, drawableModes) {
 *       return this.transport.request('POST', '/api/internal/user-hints/next',
 *         { ...input, modes: drawableModes });
 *     }
 *
 * The header NAME is pinned as a literal too. It is half of a contract whose
 * other half lives in a different repository, and a typo in either one degrades
 * every customer to MODAL-only — silently, because the panel's default for a
 * cabinet that says nothing is exactly MODAL.
 */

/** The transport, recording all four arguments — which is the whole point. */
function fakeTransport() {
  const request = vi.fn(async () => ({ hint: null }));
  return { request } as unknown as {
    request: ReturnType<typeof vi.fn>;
  };
}

const AUDIENCE = {
  userId: 'user-1',
  surface: 'pwa',
  formFactor: 'mobile',
  locale: 'ru',
} as const;

describe('UserHintsNamespace.next', () => {
  it('sends the drawable modes as a header, never as a body field', async () => {
    const transport = fakeTransport();
    const namespace = new UserHintsNamespace(transport as never);

    await namespace.next({ ...AUDIENCE }, ['MODAL', 'TOAST']);

    expect(transport.request).toHaveBeenCalledTimes(1);
    const [method, path, body, headers] = transport.request.mock.calls[0] as [
      string,
      string,
      unknown,
      unknown,
    ];
    expect(method).toBe('POST');
    expect(path).toBe('/api/internal/user-hints/next');
    expect(
      headers,
      'the modes did not reach the fourth argument — anything else is a 400 from a panel whose DTO has not learned the field, and the route turns that into `{ hint: null }` for everybody',
    ).toEqual({ 'x-reiwa-hint-modes': 'MODAL,TOAST' });
    expect(
      body,
      'the modes were put in the request body, which `forbidNonWhitelisted` answers with 400',
    ).toEqual(AUDIENCE);
  });

  it('pins the header name itself, on both sides of the constant', async () => {
    // The literal, because the panel reads a literal. Asserting only
    // `HINT_MODES_HEADER` would let a typo in the constant travel intact.
    expect(HINT_MODES_HEADER).toBe('x-reiwa-hint-modes');

    const transport = fakeTransport();
    await new UserHintsNamespace(transport as never).next({ ...AUDIENCE }, ['MODAL']);

    const headers = transport.request.mock.calls[0]?.[3] as Record<string, string>;
    expect(Object.keys(headers)).toEqual(['x-reiwa-hint-modes']);
    expect(headers['x-reiwa-hint-modes']).toBe('MODAL');
  });

  it('sends no header at all when the caller declares nothing', async () => {
    // The panel treats an absent header as MODAL. An EMPTY header is a
    // different claim — "this build draws nothing" — and would hold every hint
    // back for ever.
    const transport = fakeTransport();
    const namespace = new UserHintsNamespace(transport as never);

    await namespace.next({ ...AUDIENCE });
    await namespace.next({ ...AUDIENCE }, []);

    for (const call of transport.request.mock.calls) {
      expect(call[3], 'an empty mode list was sent as a header').toBeUndefined();
      expect(call[2]).toEqual(AUDIENCE);
    }
  });

  it('leaves the other three calls with a body and no headers', async () => {
    // Anti-overreach: only `next` negotiates modes. A header on `shown` or
    // `closed` would be a second contract nobody agreed to.
    const transport = fakeTransport();
    const namespace = new UserHintsNamespace(transport as never);

    await namespace.moment({ ...AUDIENCE, moment: 'subscription-ready' });
    await namespace.markShown({ ...AUDIENCE, deliveryId: 'd1' });
    await namespace.close({ ...AUDIENCE, deliveryId: 'd1', outcome: 'acted' });

    expect(transport.request.mock.calls.map((call) => call[1])).toEqual([
      '/api/internal/user-hints/moment',
      '/api/internal/user-hints/shown',
      '/api/internal/user-hints/closed',
    ]);
    for (const call of transport.request.mock.calls) {
      expect(call[3]).toBeUndefined();
    }
  });
});
