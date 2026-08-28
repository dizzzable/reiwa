import { describe, expect, it, vi } from 'vitest';

import { invalidateStaleUserSession } from '../../../src/api/lib/stale-user-session.js';
import { UpstreamError } from '../../../src/core/errors/index.js';

/**
 * A block that leaves the cookie alive is not a block
 * ═══════════════════════════════════════════════════
 *
 * The cabinet authenticates every route against its OWN Redis session and only
 * asks the panel when it needs the profile. So an operator blocking a customer
 * who is signed in used to change one screen and nothing else: `/profile` 403'd
 * and the PWA showed an error, while devices, referrals — and, until it was
 * gated separately, claiming a free trial — kept working from the same cookie.
 *
 * The panel was already saying so on every profile read. Nothing was listening.
 */

function buildRequest() {
  const destroyWebSession = vi.fn(async () => undefined);
  return {
    req: { destroyWebSession, log: undefined } as never,
    destroyWebSession,
  };
}

function blockedError(): UpstreamError {
  // Exactly what Nest serialises for `new ForbiddenException({ code, message })`.
  return new UpstreamError(
    'GET',
    '/internal/user/session',
    403,
    JSON.stringify({ code: 'USER_BLOCKED', message: 'USER_BLOCKED', statusCode: 403 }),
  );
}

describe('a blocked account loses its cabinet session', () => {
  it('destroys the session when the panel answers USER_BLOCKED', async () => {
    const { req, destroyWebSession } = buildRequest();

    const handled = await invalidateStaleUserSession(req, blockedError());

    expect(handled).toBe(true);
    expect(destroyWebSession).toHaveBeenCalledOnce();
  });

  it('still destroys it for a deleted account, which is the case it already covered', async () => {
    const { req, destroyWebSession } = buildRequest();
    const notFound = new UpstreamError('GET', '/internal/user/session', 404, 'User not found');

    const handled = await invalidateStaleUserSession(req, notFound);

    expect(handled).toBe(true);
    expect(destroyWebSession).toHaveBeenCalledOnce();
  });

  it('leaves the session alone for an unrelated failure', async () => {
    // A panel hiccup must not sign everybody out. Only the two answers that
    // mean "this session can never work again" end it.
    const { req, destroyWebSession } = buildRequest();
    const boom = new UpstreamError('GET', '/internal/user/session', 502, 'bad gateway');

    const handled = await invalidateStaleUserSession(req, boom);

    expect(handled).toBe(false);
    expect(destroyWebSession).not.toHaveBeenCalled();
  });

  it('leaves the session alone for a 403 that is not a block', async () => {
    // The code is what decides, not the status: the panel refuses at 403 for
    // several distinct reasons and only one of them invalidates the session.
    const { req, destroyWebSession } = buildRequest();
    const other = new UpstreamError(
      'GET',
      '/internal/user/session',
      403,
      JSON.stringify({ code: 'REGISTRATION_DISABLED', statusCode: 403 }),
    );

    const handled = await invalidateStaleUserSession(req, other);

    expect(handled).toBe(false);
    expect(destroyWebSession).not.toHaveBeenCalled();
  });
});
