/**
 * Request-id middleware.
 *
 * Honours an inbound `x-request-id` header (so the bot, the SPA and
 * external probes can propagate a correlation id end-to-end).
 * When the header is missing or empty, a fresh UUID v4 is generated.
 *
 * The id is exposed three ways:
 *   - `req.id` so `pino-http` can bind it to every log line on this turn
 *   - `res.locals['requestId']` so route handlers can include it in
 *     payloads or forward it onto the AdminClient via `extraHeaders`
 *   - the `x-request-id` response header so the caller can quote it in
 *     bug reports
 *
 * Mounted before `pino-http` so the access log carries the same id.
 *
 * Note: `pino-http` already augments `express.Request` with `id`, so we
 * cast through `Request & { id: string }` rather than declaring our own
 * module augmentation (which would collide with pino-http's typings).
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { REQUEST_ID_HEADER } from '../../infrastructure/logger/index.js';

export function requestIdMiddleware() {
  return function requestIdMw(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const id =
      typeof incoming === 'string' && incoming.trim().length > 0
        ? incoming.trim()
        : randomUUID();
    (req as Request & { id: string }).id = id;
    res.locals['requestId'] = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
