/**
 * Logger barrel.
 *
 * `createLogger({ service })` returns a configured pino root logger.
 * `requestIdHeader` is the canonical incoming/outgoing request-id
 * header name used across the bot ↔ api ↔ admin chain.
 */
export { createLogger, type CreateLoggerOptions, type LogLevel, type Logger } from './logger.js';
export {
  getCurrentRequestId,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from './request-context.js';

/**
 * Canonical request-id header. Inbound requests with this header
 * inherit the upstream id; otherwise a fresh UUID v4 is generated and
 * propagated downstream (admin client, log lines, response headers).
 */
export const REQUEST_ID_HEADER = 'x-request-id';
