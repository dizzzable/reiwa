/**
 * Per-request logger accessor.
 *
 * Pino-http attaches a child logger to every incoming Express request as
 * `req.log` (carries the request-id binding from `requestIdMiddleware`).
 * This helper returns that child when present, otherwise falls back to a
 * console shim so route handlers stay safe in tests / supervised scripts
 * that mount `createApp` without a logger.
 *
 * Returning a `LoggerLike` instead of the full `pino.Logger` keeps route
 * handlers decoupled from the concrete logger — they treat it as an
 * opaque structured-logging sink. The shape matches the subset of
 * `pino`'s API that the routes touch (`info`, `warn`, `error`, plus a
 * `child(bindings)` for ad-hoc context).
 */
import type { Request } from 'express';

export interface LoggerLike {
  info(ctx: object, message: string): void;
  info(message: string): void;
  warn(ctx: object, message: string): void;
  warn(message: string): void;
  error(ctx: object, message: string): void;
  error(message: string): void;
  debug(ctx: object, message: string): void;
  debug(message: string): void;
  child(bindings: object): LoggerLike;
}

const consoleShim: LoggerLike = {
  info(ctxOrMsg: object | string, message?: string): void {
    if (typeof ctxOrMsg === 'string') console.log(ctxOrMsg);
    else console.log(message ?? '', ctxOrMsg);
  },
  warn(ctxOrMsg: object | string, message?: string): void {
    if (typeof ctxOrMsg === 'string') console.warn(ctxOrMsg);
    else console.warn(message ?? '', ctxOrMsg);
  },
  error(ctxOrMsg: object | string, message?: string): void {
    if (typeof ctxOrMsg === 'string') console.error(ctxOrMsg);
    else console.error(message ?? '', ctxOrMsg);
  },
  debug(ctxOrMsg: object | string, message?: string): void {
    if (typeof ctxOrMsg === 'string') console.debug(ctxOrMsg);
    else console.debug(message ?? '', ctxOrMsg);
  },
  child() {
    return consoleShim;
  },
};

/**
 * Returns the per-request logger attached by `pino-http`, or a console
 * shim when the app was constructed without a logger (tests, scripts).
 */
export function getRequestLogger(req: Request): LoggerLike {
  const log = (req as { log?: LoggerLike }).log;
  return log ?? consoleShim;
}
