import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createErrorReporter } from '../../src/infrastructure/error-reporter/index.js';

interface Recorded {
  calls: Array<Record<string, unknown>>;
}

function fakeAdminClient(recorded: Recorded): { system: { reportError: (i: Record<string, unknown>) => Promise<unknown> } } {
  return {
    system: {
      reportError: async (input) => {
        recorded.calls.push(input);
        return { ok: true };
      },
    },
  };
}

describe('createErrorReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the first error to adminClient.system.reportError', async () => {
    const recorded: Recorded = { calls: [] };
    const reporter = createErrorReporter({
      adminClient: fakeAdminClient(recorded) as never,
      source: 'bot',
    });
    reporter.report({ message: 'boom', stack: 'at x', context: { scope: 'test' } });
    await vi.runAllTimersAsync();
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ source: 'bot', message: 'boom' });
  });

  it('is a no-op when no admin client is configured', async () => {
    const reporter = createErrorReporter({ adminClient: null, source: 'api' });
    // Must not throw.
    reporter.report({ message: 'no client' });
    await vi.runAllTimersAsync();
  });

  it('de-dups identical messages within the window', async () => {
    const recorded: Recorded = { calls: [] };
    const reporter = createErrorReporter({
      adminClient: fakeAdminClient(recorded) as never,
      source: 'worker',
    });
    reporter.report({ message: 'same' });
    reporter.report({ message: 'same' });
    reporter.report({ message: 'same' });
    await vi.runAllTimersAsync();
    expect(recorded.calls).toHaveLength(1);

    // After the dedup window elapses, the same message is reported again.
    vi.advanceTimersByTime(61_000);
    reporter.report({ message: 'same' });
    await vi.runAllTimersAsync();
    expect(recorded.calls).toHaveLength(2);
  });

  it('caps the number of reports per rolling minute', async () => {
    const recorded: Recorded = { calls: [] };
    const reporter = createErrorReporter({
      adminClient: fakeAdminClient(recorded) as never,
      source: 'bot',
    });
    // 40 distinct messages in the same minute → capped at 30.
    for (let i = 0; i < 40; i += 1) {
      reporter.report({ message: `err-${i}` });
    }
    await vi.runAllTimersAsync();
    expect(recorded.calls.length).toBe(30);
  });
});
