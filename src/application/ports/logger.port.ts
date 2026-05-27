/**
 * Application-side logger port.
 *
 * Use cases and domain-level services depend on this narrow surface;
 * the concrete implementation (`pino` Logger from
 * `infrastructure/logger`) implements the same shape so it can be
 * passed in directly with no adapter.
 *
 * Methods take an optional context object and a message string in the
 * pino convention. Context is attached as structured fields, never
 * stringified into the message.
 */
export interface LoggerPort {
  fatal(ctx: object, message: string): void;
  fatal(message: string): void;
  error(ctx: object, message: string): void;
  error(message: string): void;
  warn(ctx: object, message: string): void;
  warn(message: string): void;
  info(ctx: object, message: string): void;
  info(message: string): void;
  debug(ctx: object, message: string): void;
  debug(message: string): void;
  trace(ctx: object, message: string): void;
  trace(message: string): void;
  /**
   * Spawn a child logger with extra context bound. Child logs inherit
   * the parent's level and are correlated by the parent's bindings —
   * use this for per-request / per-job loggers.
   */
  child(bindings: object): LoggerPort;
}
