import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installProcessErrorGuards,
  __resetProcessErrorGuardsForTest,
} from '../../src/infrastructure/error-reporter/process-guards.js';

/**
 * Process-level guards: stray rejections / uncaught throws must be logged AND
 * forwarded to the dev firehose. `exitOnUncaught: false` keeps the test
 * runner alive; the exit path is covered by inspection, not by killing vitest.
 */

let prevUnhandled: NodeJS.UnhandledRejectionListener[];
let prevUncaught: NodeJS.UncaughtExceptionListener[];

beforeEach(() => {
  __resetProcessErrorGuardsForTest();
  prevUnhandled = process.listeners('unhandledRejection');
  prevUncaught = process.listeners('uncaughtException');
});

afterEach(() => {
  // Drop the guards we installed and restore the runner's own listeners.
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  for (const l of prevUnhandled) process.on('unhandledRejection', l);
  for (const l of prevUncaught) process.on('uncaughtException', l);
});

function fakeLogger() {
  return {
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('installProcessErrorGuards', () => {
  it('logs + reports an unhandledRejection without exiting', () => {
    const logger = fakeLogger();
    const report = vi.fn();
    installProcessErrorGuards({
      logger: logger as never,
      errorReporter: { report } as never,
      exitOnUncaught: false,
    });

    process.emit('unhandledRejection', new Error('stray'), Promise.resolve());

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      context: { scope: 'process.unhandledRejection' },
    });
  });

  it('logs fatal + reports an uncaughtException', () => {
    const logger = fakeLogger();
    const report = vi.fn();
    installProcessErrorGuards({
      logger: logger as never,
      errorReporter: { report } as never,
      exitOnUncaught: false,
    });

    process.emit('uncaughtException', new Error('boom'));

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      message: 'Uncaught exception: boom',
      context: { scope: 'process.uncaughtException' },
    });
  });

  it('is idempotent — a second install adds no extra listeners', () => {
    const before = process.listenerCount('uncaughtException');
    const logger = fakeLogger();
    installProcessErrorGuards({ logger: logger as never, errorReporter: { report: vi.fn() } as never, exitOnUncaught: false });
    installProcessErrorGuards({ logger: logger as never, errorReporter: { report: vi.fn() } as never, exitOnUncaught: false });
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
  });
});
