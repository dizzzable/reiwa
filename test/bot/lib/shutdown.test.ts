import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installBotShutdownHandlers,
  runBotShutdown,
  type BotShutdownSteps,
} from '../../../src/bot/lib/shutdown.js';

/**
 * Graceful shutdown of the bot process.
 *
 * This exists because the absence it replaces was invisible. The bot ran for a
 * long time with no signal handler, and nothing looked broken: `docker stop`
 * worked, the container came back, the polling loop retried. What it cost was
 * paid one restart later, as a `409 Conflict` against a polling slot the
 * previous instance never released — and the loop's own comment blamed that on
 * "a previous instance crashing mid-getUpdates", which is exactly what an
 * unhandled SIGTERM makes every ordinary restart into.
 *
 * So the assertions here are about ORDER and BOUNDS, not about whether the
 * steps run at all:
 *
 *   • the polling slot is released BEFORE the farewell is sent. A slow
 *     `sendMessage` must never be what stands between SIGTERM and `bot.stop()`.
 *   • every step is bounded. Docker's implicit grace is ten seconds and no
 *     `stop_grace_period` is configured, so an unbounded await is just a
 *     SIGKILL with extra steps.
 *   • one step failing does not cancel the rest. The farewell is the least
 *     important thing here and it is also the most likely to fail.
 */

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function steps(overrides: Partial<BotShutdownSteps> = {}): BotShutdownSteps & {
  readonly logger: ReturnType<typeof fakeLogger>;
} {
  const logger = fakeLogger();
  return {
    startedAt: 1_000,
    now: () => 1_000,
    logger,
    clearTimers: vi.fn(),
    stopPolling: vi.fn(async () => undefined),
    farewell: vi.fn(async () => undefined),
    closeServer: vi.fn(async () => undefined),
    ...overrides,
  } as BotShutdownSteps & { readonly logger: ReturnType<typeof fakeLogger> };
}

describe('runBotShutdown', () => {
  it('releases the polling slot before it tries to say goodbye', async () => {
    const order: string[] = [];
    await runBotShutdown(
      'SIGTERM',
      steps({
        clearTimers: () => void order.push('timers'),
        stopPolling: async () => void order.push('stop'),
        farewell: async () => void order.push('farewell'),
        closeServer: async () => void order.push('server'),
      }),
    );

    // The stop is the only step with a consequence outside this process:
    // Telegram holds the slot for ~30s after an unclean exit, and the next
    // boot pays for it. The notice is a courtesy and goes second.
    expect(order).toStrictEqual(['timers', 'stop', 'farewell', 'server']);
  });

  it('hands the farewell the signal and the measured uptime', async () => {
    const farewell = vi.fn(async () => undefined);
    // Two hours and change, expressed as clock values rather than a slept-for
    // duration, so this says nothing about how fast the test runs.
    await runBotShutdown('SIGINT', steps({ startedAt: 1_000, now: () => 7_400_000, farewell }));

    expect(farewell).toHaveBeenCalledWith('SIGINT', 7_399_000);
  });

  it('carries on when releasing the polling slot fails', async () => {
    // A failed `bot.stop()` is the case where the farewell matters MOST — the
    // operator is about to meet a 409 on the next boot and the message is the
    // only warning they get.
    const farewell = vi.fn(async () => undefined);
    const closeServer = vi.fn(async () => undefined);
    const s = steps({
      stopPolling: async () => {
        throw new Error('telegram unreachable');
      },
      farewell,
      closeServer,
    });

    await runBotShutdown('SIGTERM', s);

    expect(farewell).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(s.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'stopPolling' }),
      expect.stringContaining('step failed'),
    );
  });

  it('tolerates a process with no internal listener to close', async () => {
    // `startInternalHttpListener` returns null when the shared secret is unset,
    // which is the ordinary state of a dev machine.
    const s = steps({ closeServer: null });
    await expect(runBotShutdown('SIGTERM', s)).resolves.toBeUndefined();
  });

  describe('under the SIGKILL clock', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('abandons a step that overruns instead of awaiting it into the kill', async () => {
      const hangForever = () => new Promise<void>(() => undefined);
      const closeServer = vi.fn(async () => undefined);
      const s = steps({ stopPolling: hangForever, farewell: hangForever, closeServer });

      const done = runBotShutdown('SIGTERM', s);
      // Past both budgets (3s + 4s) with room to spare, still inside Docker's
      // ten. If either step were unbounded this never settles.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(done).resolves.toBeUndefined();

      expect(closeServer).toHaveBeenCalledOnce();
      expect(s.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'stopPolling' }),
        expect.stringContaining('exceeded its budget'),
      );
      expect(s.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'farewell' }),
        expect.stringContaining('exceeded its budget'),
      );
    });

    it('does not sit on its budget when the steps are quick', async () => {
      // The mirror of the test above, and the reason it is here: a `withinBudget`
      // that always waited out the full timer would pass every assertion in this
      // file while turning a 200ms shutdown into a seven-second one.
      const s = steps();
      let settled = false;
      void runBotShutdown('SIGTERM', s).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
    });
  });
});

describe('installBotShutdownHandlers', () => {
  let previousTerm: NodeJS.SignalsListener[];
  let previousInt: NodeJS.SignalsListener[];

  beforeEach(() => {
    previousTerm = process.listeners('SIGTERM');
    previousInt = process.listeners('SIGINT');
  });

  afterEach(() => {
    // Restore the runner's own listeners — vitest installs some of these.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    for (const l of previousTerm) process.on('SIGTERM', l);
    for (const l of previousInt) process.on('SIGINT', l);
  });

  it('runs the sequence once however many signals arrive', async () => {
    // Docker sends SIGTERM; an impatient operator adds Ctrl-C. A second pass
    // would call `bot.stop()` on a stopped bot and send the farewell twice.
    const s = steps();
    const exit = vi.fn();
    installBotShutdownHandlers(s, exit);

    process.emit('SIGTERM');
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(s.stopPolling).toHaveBeenCalledOnce();
    expect(s.farewell).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('still exits when the sequence itself throws', async () => {
    // `runBotShutdown` swallows per-step failures, so this is the case where
    // something in the sequence — not a step — broke. Refusing to exit would
    // leave the container to be SIGKILLed, which is the outcome this whole
    // file exists to avoid.
    const exit = vi.fn();
    installBotShutdownHandlers(
      steps({
        clearTimers: () => {
          throw new Error('boom');
        },
      }),
      exit,
    );

    process.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
