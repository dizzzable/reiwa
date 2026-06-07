/**
 * Safe error responder for route handlers.
 *
 * Centralises the "log the detail server-side, return a generic message to
 * the browser" pattern so route catch-blocks never forward an upstream
 * error verbatim. This matters because `UpstreamError.message` embeds the
 * raw upstream response body AND the internal `/api/internal/...` path
 * (see `core/errors/upstream-error.ts`), both of which are sensitive:
 * leaking them to the client exposes provider diagnostics and the internal
 * API surface, violating the project's safety rules.
 *
 * Use this instead of `res.status(...).json({ message: (e as Error).message })`.
 */
import type { Request, Response } from 'express';

import { getRequestLogger } from '../middleware/logger-accessor.js';
import { describeUpstreamError } from './upstream-error.js';

/**
 * Log the failure with full detail (request-scoped logger) and respond with
 * a generic, client-safe message.
 *
 * @param status  HTTP status to return (the caller's chosen contract — not
 *                derived from the upstream, to avoid surprising the SPA).
 * @param message Generic, non-sensitive message safe to show the user.
 * @param context Short log label, e.g. `"payments/checkout"`.
 */
export function sendSafeError(
  req: Request,
  res: Response,
  e: unknown,
  status: number,
  message: string,
  context: string,
): void {
  const detail = describeUpstreamError(e);
  getRequestLogger(req).error(
    { err: e, upstreamStatus: detail.status },
    `${context} failed`,
  );
  res.status(status).json({ message });
}
