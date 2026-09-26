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

/**
 * The panel's refusal of a blocked account's session read, as its
 * `AdminSafeExceptionFilter` puts it on the wire — the filter's own output for
 * `new ForbiddenException({ code: 'USER_BLOCKED', message: 'USER_BLOCKED' })`
 * (`internal-user.service.ts#getSession`), produced by running the filter
 * (`$SW/pair/a1-work/filter-body.cjs`), not Nest's default shape. The filter
 * forwards `code` only for `SAFE_PRODUCT_CODES`: `USER_BLOCKED` joins them in
 * Rezeis Admin 0.9.7.71; up to 0.9.7.70 it is stripped and only the sentence —
 * here the code spelled as its own message — survives, with a status-derived
 * `errorCode`. The old stub (`{ code, message, statusCode }`) was a body no
 * panel ever sent, which is how this helper passed while never firing.
 */
function blockedError(panel: 'forwards the code' | 'strips the code'): UpstreamError {
  const common = {
    timestamp: '2026-09-26T12:00:00.000Z',
    path: '/api/internal/user/session',
    requestId: 'req-a1-1',
    statusCode: 403,
    message: 'USER_BLOCKED',
  };
  const body =
    panel === 'forwards the code'
      ? { ...common, errorCode: 'USER_BLOCKED', code: 'USER_BLOCKED' }
      : { ...common, errorCode: 'FORBIDDEN' };
  return new UpstreamError('GET', '/api/internal/user/session?userId=user-1', 403, JSON.stringify(body));
}

describe('a blocked account loses its cabinet session', () => {
  it('destroys the session when the panel forwards USER_BLOCKED (0.9.7.71 and later)', async () => {
    const { req, destroyWebSession } = buildRequest();

    const handled = await invalidateStaleUserSession(req, blockedError('forwards the code'));

    expect(handled).toBe(true);
    expect(destroyWebSession).toHaveBeenCalledOnce();
  });

  it('destroys it too when the panel stripped the code (0.9.7.70 and older): by the status and the exact sentence', async () => {
    const { req, destroyWebSession } = buildRequest();

    const handled = await invalidateStaleUserSession(req, blockedError('strips the code'));

    expect(handled).toBe(true);
    expect(destroyWebSession).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'another code beside the blocked sentence: the code wins',
      403,
      { statusCode: 403, message: 'USER_BLOCKED', errorCode: 'REGISTRATION_DISABLED', code: 'REGISTRATION_DISABLED' },
    ],
    ['the sentence at another status', 400, { statusCode: 400, message: 'USER_BLOCKED', errorCode: 'BAD_REQUEST' }],
    ['a 403 with another sentence', 403, { statusCode: 403, message: 'Request failed', errorCode: 'FORBIDDEN' }],
    ['the sentence in another case', 403, { statusCode: 403, message: 'user_blocked', errorCode: 'FORBIDDEN' }],
  ] as const)('keeps the session for %s', async (_name, status, body) => {
    const { req, destroyWebSession } = buildRequest();
    const error = new UpstreamError('GET', '/api/internal/user/session?userId=user-1', status, JSON.stringify(body));

    expect(await invalidateStaleUserSession(req, error)).toBe(false);
    expect(destroyWebSession).not.toHaveBeenCalled();
  });

  it('keeps the session for a failure that is not the panel answering', async () => {
    const { req, destroyWebSession } = buildRequest();

    expect(await invalidateStaleUserSession(req, new Error('403 USER_BLOCKED'))).toBe(false);
    expect(destroyWebSession).not.toHaveBeenCalled();
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
