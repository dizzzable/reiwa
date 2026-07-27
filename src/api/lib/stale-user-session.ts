import type { Request } from 'express';

import { isUpstreamUserNotFound } from './upstream-error.js';
import { getRequestLogger } from '../middleware/logger-accessor.js';

/**
 * Invalidates a WebSession after a typed upstream "User not found" response.
 * The reiwa CUID in a WebSession can outlive a deleted rezeis account; keeping
 * that cookie would make every later request
 * look authenticated and keep producing false server errors.
 */
export async function invalidateStaleUserSession(
  req: Request,
  error: unknown,
): Promise<boolean> {
  if (!isUpstreamUserNotFound(error)) return false;

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
