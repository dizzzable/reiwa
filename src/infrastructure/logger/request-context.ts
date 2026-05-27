/**
 * Per-request context propagated via AsyncLocalStorage.
 *
 * Stores the active `requestId` for the current async chain. The
 * request-id middleware seeds the store; any downstream code (HTTP
 * client, message bus producer, log statement) reads it back without
 * having to thread the id through every function signature.
 *
 * Pattern adopted from pino-http and Nest's RequestContext middleware:
 * AsyncLocalStorage tracks the originating async tick so listeners
 * registered inside the request scope (e.g. `setImmediate`, `setTimeout`,
 * promise-chained DB calls) inherit the same context.
 *
 * Reads outside an active scope return `undefined` — callers that need
 * a header value should fall back to omitting the header rather than
 * synthesising a placeholder.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `ctx` bound as the active request context. The
 * middleware wraps `next()` in this so every downstream `await`
 * inherits the id.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Read the active context, or `undefined` when called outside any
 * request scope (e.g. the worker's interval tick or the bot's
 * dispatcher pre-update). Callers must handle `undefined` rather than
 * branch on a synthetic placeholder.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Convenience: returns the active request id, or `undefined` outside a
 * request scope.
 */
export function getCurrentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
