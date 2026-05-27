/**
 * getRequestLogger specs.
 *
 *   - returns the per-request pino child attached as `req.log` when
 *     pino-http is mounted
 *   - falls back to a console-shim when no logger is attached so route
 *     handlers stay safe in tests / supervised scripts
 *   - the console-shim implements the documented `LoggerLike` surface
 *     so call sites can use either with no narrowing
 */
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { getRequestLogger, type LoggerLike } from '../../../src/api/middleware/logger-accessor.js';

function buildReq(log?: LoggerLike): Request {
  return ({ log } as unknown) as Request;
}

describe('getRequestLogger', () => {
  it('returns the attached req.log when present', () => {
    const fake: LoggerLike = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    const log = getRequestLogger(buildReq(fake));
    expect(log).toBe(fake);
  });

  it('falls back to a shim when req.log is missing', () => {
    const log = getRequestLogger(buildReq(undefined));
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  it('console-shim child() returns the shim itself (idempotent)', () => {
    const log = getRequestLogger(buildReq(undefined));
    const child = log.child({ foo: 'bar' });
    expect(typeof child.error).toBe('function');
  });

  it('console-shim accepts both (ctx, msg) and (msg) signatures without throwing', () => {
    const log = getRequestLogger(buildReq(undefined));
    expect(() => log.info('plain message')).not.toThrow();
    expect(() => log.info({ ctx: 1 }, 'with-context')).not.toThrow();
    expect(() => log.error('plain')).not.toThrow();
    expect(() => log.error({ err: new Error('x') }, 'structured')).not.toThrow();
  });
});
