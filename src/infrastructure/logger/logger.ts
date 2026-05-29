/**
 * Pino logger factory.
 *
 * One root logger per process; child loggers are spawned per request
 * (via `pino-http`) and per long-running task (worker tick, bot
 * dispatcher) using `logger.child({ ... })`. Stdout JSON in production
 * is Docker-friendly and ships straight into the operator's log pipeline.
 *
 * In dev (`NODE_ENV !== 'production'`) we route through `pino-pretty` if
 * available, otherwise fall back to plain JSON — the dev container does
 * not bundle `pino-pretty`, so this is a soft optional.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface CreateLoggerOptions {
  /**
   * `bot` / `api` / `worker` — populated as `service` on every log line
   * so multi-process logs interleaved in Docker can be split downstream.
   */
  readonly service: 'api' | 'bot' | 'worker';
  readonly level?: LogLevel;
  readonly pretty?: boolean;
}

const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-request-signature"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  // Client-side password hashes are password-equivalent bearer secrets
  // (web prehashes with SHA-256 and ships the digest as the credential).
  // Redact every level they can surface at: top-level body fields, one
  // level deep (`req.body.*`, namespace payloads), and request bodies.
  'passwordHash',
  'currentPasswordHash',
  'newPasswordHash',
  '*.passwordHash',
  '*.currentPasswordHash',
  '*.newPasswordHash',
  'req.body.passwordHash',
  'req.body.currentPasswordHash',
  'req.body.newPasswordHash',
];

export function createLogger(options: CreateLoggerOptions): Logger {
  const level: LogLevel = options.level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';
  const opts: LoggerOptions = {
    level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], remove: true },
  };

  if (options.pretty) {
    // `pino-pretty` is an optional dep — we don't ship it in production.
    // If the require fails (e.g. inside the prod container), fall back to
    // plain JSON output silently.
    try {
      const transport = pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
      });
      return pino(opts, transport);
    } catch {
      // pino-pretty not installed — emit JSON.
    }
  }

  return pino(opts);
}

export type { Logger };
