/**
 * requestIdMiddleware specs.
 *
 * The middleware is invoked directly with synthetic Express-shaped
 * fakes — it doesn't depend on any router internals, so this stays
 * fast and hermetic.
 *
 * Pinned behaviours:
 *   - inbound `x-request-id` is honoured (whitespace-trimmed)
 *   - missing/empty inbound id falls back to a generated UUID v4
 *   - `req.id` is set, so `pino-http`'s `genReqId` reads it back
 *   - `res.locals.requestId` carries the same value (used by route
 *     handlers that want to thread the id without re-importing the
 *     header constant)
 *   - the response header is set so the SPA / probe sees the id
 *   - the rest of the middleware chain runs inside the
 *     AsyncLocalStorage scope opened by `runWithRequestContext`
 */
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { requestIdMiddleware } from '../../../src/api/middleware/request-id.js';
import { getCurrentRequestId } from '../../../src/infrastructure/logger/request-context.js';

interface FakeReqRes {
  req: Partial<Request>;
  res: Partial<Response>;
  responseHeaders: Record<string, string>;
  locals: Record<string, unknown>;
}

function buildFakes(headers: Record<string, string | undefined> = {}): FakeReqRes {
  const responseHeaders: Record<string, string> = {};
  const locals: Record<string, unknown> = {};
  const req: Partial<Request> = { headers };
  const res: Partial<Response> = {
    locals,
    setHeader(name: string, value: string | number | readonly string[]): Response {
      responseHeaders[name] = String(value);
      return res as Response;
    },
  };
  return { req, res, responseHeaders, locals };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('requestIdMiddleware', () => {
  it('honours an inbound x-request-id header', async () => {
    const { req, res, responseHeaders, locals } = buildFakes({
      'x-request-id': 'incoming-123',
    });
    const next: NextFunction = () => undefined;
    const mw = requestIdMiddleware();

    mw(req as Request, res as Response, next);

    expect((req as Request & { id: string }).id).toBe('incoming-123');
    expect(locals['requestId']).toBe('incoming-123');
    expect(responseHeaders['x-request-id']).toBe('incoming-123');
  });

  it('trims surrounding whitespace before adopting the inbound id', () => {
    const { req, res, responseHeaders } = buildFakes({
      'x-request-id': '   abc   ',
    });
    requestIdMiddleware()(req as Request, res as Response, () => undefined);
    expect((req as Request & { id: string }).id).toBe('abc');
    expect(responseHeaders['x-request-id']).toBe('abc');
  });

  it('generates a UUID v4 fallback when the header is missing', () => {
    const { req, res } = buildFakes();
    requestIdMiddleware()(req as Request, res as Response, () => undefined);
    expect((req as Request & { id: string }).id).toMatch(UUID_V4_RE);
  });

  it('generates a UUID v4 fallback when the header is whitespace-only', () => {
    const { req, res } = buildFakes({ 'x-request-id': '   ' });
    requestIdMiddleware()(req as Request, res as Response, () => undefined);
    expect((req as Request & { id: string }).id).toMatch(UUID_V4_RE);
  });

  it('opens a runWithRequestContext scope before invoking next()', () => {
    const { req, res } = buildFakes({ 'x-request-id': 'scope-test' });
    let observed: string | undefined;
    requestIdMiddleware()(req as Request, res as Response, () => {
      observed = getCurrentRequestId();
    });
    expect(observed).toBe('scope-test');
  });

  it('the AsyncLocalStorage scope does not leak past next()', () => {
    const { req, res } = buildFakes({ 'x-request-id': 'leak-test' });
    requestIdMiddleware()(req as Request, res as Response, () => undefined);
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it('generates distinct ids on consecutive calls when no header is supplied', () => {
    const a = buildFakes();
    const b = buildFakes();
    requestIdMiddleware()(a.req as Request, a.res as Response, () => undefined);
    requestIdMiddleware()(b.req as Request, b.res as Response, () => undefined);
    const idA = (a.req as Request & { id: string }).id;
    const idB = (b.req as Request & { id: string }).id;
    expect(idA).not.toBe(idB);
  });
});
