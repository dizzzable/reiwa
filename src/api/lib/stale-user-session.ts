import type { Request } from 'express';

import { UpstreamError } from '../../core/errors/index.js';
import { isUpstreamUserNotFound, readUpstreamCode } from './upstream-error.js';
import { getRequestLogger } from '../middleware/logger-accessor.js';

/**
 * `USER_BLOCKED`, as the panel's error filter actually delivers it.
 *
 * Rezeis Admin 0.9.7.71 and later forward the code (`SAFE_PRODUCT_CODES`), and
 * a body that names a code is read by that code alone. 0.9.7.70 and older strip
 * it and forward only the sentence — `403 { message: 'USER_BLOCKED', errorCode:
 * 'FORBIDDEN' }` for the session read every caller of this helper meets
 * (rezeis-admin `internal-user.service.ts#getSession`, whose sentence is the
 * code itself) — so a body with no code is read by that status and that exact
 * message. Until this, the helper read only the code, which that panel never
 * sent: a blocked customer kept their cabinet session.
 */
function isBlockedAnswer(error: unknown): boolean {
  const code = readUpstreamCode(error);
  if (code !== null) return code === 'USER_BLOCKED';
  if (!(error instanceof UpstreamError) || error.status !== 403) return false;
  try {
    const body: unknown = JSON.parse(error.body);
    return typeof body === 'object' && body !== null && (body as { message?: unknown }).message === 'USER_BLOCKED';
  } catch {
    return false;
  }
}

/**
 * Invalidates a WebSession the panel has just told us is no longer usable.
 *
 * Two upstream answers mean that, and both leave a cookie that would otherwise
 * keep every later request looking authenticated:
 *
 *   • "User not found" — the reiwa CUID outlived a deleted rezeis account, and
 *     the stale cookie keeps producing false server errors;
 *   • `USER_BLOCKED` — the operator blocked the account WHILE the customer was
 *     signed in. This one was missing, and its absence made the block far
 *     weaker than it reads: the profile screen 403'd and the PWA showed an
 *     error, but the cookie survived, and every other cabinet route
 *     authenticates against the cabinet's own Redis session without asking the
 *     panel again. Devices, referrals — and, until it was gated, claiming a
 *     free trial — all kept working for somebody who had just been banned.
 */
export async function invalidateStaleUserSession(
  req: Request,
  error: unknown,
): Promise<boolean> {
  const blocked = isBlockedAnswer(error);
  if (!blocked && !isUpstreamUserNotFound(error)) return false;

  try {
    await req.destroyWebSession?.();
  } catch (cleanupError: unknown) {
    // The caller must still return its stale-session response if Redis is
    // temporarily unavailable. A later request will retry cleanup through
    // this same helper.
    // Log only the cleanup failure: the upstream error stays out of this
    // message and is never exposed to the client.
    getRequestLogger(req).warn({ err: cleanupError }, 'Failed to destroy stale web session');
  }
  return true;
}
