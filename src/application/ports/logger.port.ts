/**
 * Minimal structured logger contract used by use-cases and adapters.
 *
 * The concrete implementation is `pino` (see `infrastructure/logger`),
 * but use-cases never import pino directly so they remain testable
 * without the logger transport. `bindings` lets callers attach
 * request-id / user-id / use-case-name to nested loggers without
 * polluting the message body.
 */
export interface LoggerPort {
  trace(payload: Record<string, unknown> | string, msg?: string): void;
  debug(payload: Record<string, unknown> | string, msg?: string): void;
  info(payload: Record<string, unknown> | string, msg?: string): void;
  warn(payload: Record<string, unknown> | string, msg?: string): void;
  error(payload: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}
