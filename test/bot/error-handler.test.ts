import { describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';

import { createBotErrorHandler } from '../../src/bot/lib/error-handler.js';
import { DomainError, UserNotFoundError } from '../../src/core/errors/index.js';

/**
 * Central bot error handler — branching contract (snoups/remnashop parity):
 *   - GrammyError 403 → swallow (no report, no user message)
 *   - userFacing DomainError → friendly message, NO dev report
 *   - everything else → dev report + friendly message
 */

function fakeLogger() {
  const noop = (): void => undefined;
  const logger = {
    fatal: vi.fn(noop),
    error: vi.fn(noop),
    warn: vi.fn(noop),
    info: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    child: vi.fn(() => logger),
  };
  return logger;
}

function buildDeps(overrides?: { envSupportUsername?: string }) {
  const report = vi.fn();
  const reply = vi.fn(async () => undefined);
  const logger = fakeLogger();
  const deps = {
    logger: logger as never,
    errorReporter: { report } as never,
    translator: { t: (key: string) => key, resolveButtonLabel: (_a: string, b: string) => b } as never,
    userLocale: { getSync: () => 'ru', setSync: () => undefined, hasSync: () => true },
    getConfig: async () => ({ visual: { supportUsername: '' } }) as never,
    envSupportUsername: overrides?.envSupportUsername,
  };
  const ctx = { from: { id: 42 }, chat: { id: 42 }, reply } as never;
  return { deps, report, reply, logger, ctx };
}

function botError(error: unknown, ctx: unknown) {
  return { error, ctx, message: 'update-summary' } as never;
}

/** Build a GrammyError instance without invoking its network-shaped ctor. */
function grammyForbidden(): GrammyError {
  const e = Object.create(GrammyError.prototype) as GrammyError & {
    error_code: number;
    description: string;
  };
  e.error_code = 403;
  e.description = 'Forbidden: bot was blocked by the user';
  return e;
}

describe('createBotErrorHandler', () => {
  it('swallows GrammyError 403 (user blocked) — no report, no reply', async () => {
    const { deps, report, reply } = buildDeps();
    const handler = createBotErrorHandler(deps);
    await handler(botError(grammyForbidden(), { from: { id: 1 }, chat: { id: 1 }, reply }));
    expect(report).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('shows a friendly message for a userFacing DomainError without paging the dev', async () => {
    const { deps, report, reply, ctx } = buildDeps({ envSupportUsername: 'mysupport' });
    const handler = createBotErrorHandler(deps);
    await handler(botError(new UserNotFoundError('u-1'), ctx));
    expect(report).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    // A support button is attached when a handle is available.
    const opts = reply.mock.calls[0][1] as { reply_markup?: unknown };
    expect(opts.reply_markup).toBeDefined();
  });

  it('reports unexpected errors AND apologises to the user', async () => {
    const { deps, report, reply, ctx } = buildDeps();
    const handler = createBotErrorHandler(deps);
    await handler(botError(new Error('kaboom'), ctx));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ message: 'kaboom' });
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('treats a non-userFacing DomainError as internal (reports it)', async () => {
    class InternalDomainError extends DomainError {
      readonly code = 'INTERNAL_X';
      readonly userFacing = false;
      public constructor() {
        super('internal only');
      }
    }
    const { deps, report, reply, ctx } = buildDeps();
    const handler = createBotErrorHandler(deps);
    await handler(botError(new InternalDomainError(), ctx));
    expect(report).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
