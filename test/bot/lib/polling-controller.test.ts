import { describe, expect, it, vi } from 'vitest';

import { createPollingController } from '../../../src/bot/lib/polling-controller.js';

/**
 * The polling loop decides whether a paid update survives a restart
 * ════════════════════════════════════════════════════════════════
 *
 * The bot is the ONLY consumer of Telegram payment updates — one long-poll
 * slot per token — so everything about how it starts and stops is money-bearing
 * whether or not it looks like it.
 *
 * Two properties are asserted here, and neither was reachable before this file:
 * the loop lived inside `main.ts`, which calls `startBot()` at module load with
 * no entry guard, so no test could import it.
 */

interface FakeBot {
  readonly start: (options: Record<string, unknown>) => Promise<void>;
  readonly stop: () => Promise<void>;
}

const logger = { info: vi.fn(), warn: vi.fn() };

describe('the polling loop never discards a backlog', () => {
  it('starts with drop_pending_updates false, on the cold start and on every retry', async () => {
    // THE assertion. This was `attempt === 0` — "reset the offset cleanly on
    // cold start" — and a cold start is exactly when the backlog is most likely
    // to hold a `successful_payment` whose stars are already debited. Dropping
    // it meant the buyer was charged, got nothing, and the handler's own
    // "payment NOT recorded" ERROR never fired either, because the update it
    // would have fired for was thrown away by the restart.
    const options: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const bot: FakeBot = {
      start: async (opts) => {
        options.push(opts);
        attempts += 1;
        if (attempts < 3) throw new Error('409 Conflict');
      },
      stop: async () => undefined,
    };

    await createPollingController(bot as never, logger).run();

    expect(options).toHaveLength(3);
    for (const opts of options) {
      expect(opts.drop_pending_updates).toBe(false);
    }
  });
});

describe('stopping the bot waits for the handler still running', () => {
  it('resolves stop() only after the polling loop has finished', async () => {
    // grammY marks an update as tried BEFORE awaiting the handler, and
    // `bot.stop()` commits that offset to Telegram — "delivered, do not send it
    // again". The promise `bot.start()` returns is what resolves once the
    // middleware stack is actually done. Exiting between the two abandons the
    // handler after Telegram has been told it succeeded, which for a Stars
    // forward is a payment nobody will ever hear about again.
    // Definite-assignment rather than `| null`: the assignment happens inside
    // the executor, which TypeScript's flow analysis does not follow, so the
    // nullable spelling narrows the variable to `never` at the call below.
    let releaseHandler!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const bot: FakeBot = {
      start: async () => {
        await handlerFinished;
      },
      stop: async () => undefined,
    };

    const polling = createPollingController(bot as never, logger);
    void polling.run();
    await Promise.resolve();

    let stopped = false;
    const stopping = polling.stop().then(() => {
      stopped = true;
    });

    // The drain is still outstanding, so stop() must not have resolved.
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseHandler();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('does not take the polling slot again after a failure during shutdown', async () => {
    // `bot.stop()` on a bot that is between attempts returns instantly. Without
    // the flag the backoff elapses inside the remaining shutdown budget, the
    // loop comes round, and `bot.start()` RE-TAKES a slot that `process.exit`
    // then abandons — the stale-slot state, and the 409 on the next boot, that
    // this loop exists to avoid.
    vi.useFakeTimers();
    try {
      let starts = 0;
      const bot: FakeBot = {
        start: async () => {
          starts += 1;
          throw new Error('409 Conflict');
        },
        stop: async () => undefined,
      };

      const polling = createPollingController(bot as never, logger);
      const run = polling.run();
      await vi.advanceTimersByTimeAsync(0);
      const startsBeforeStop = starts;
      expect(startsBeforeStop).toBeGreaterThan(0);

      // `stop()` is not awaited before the clock moves: it waits for the loop,
      // and the loop is asleep in its backoff. Awaiting first would deadlock the
      // test on a timer only the test can advance — which is also, precisely,
      // why the drain needs a budget in the real shutdown.
      const stopping = polling.stop();
      // Well past the 200 ms fast-retry delay the loop would otherwise use.
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      await run;

      expect(starts).toBe(startsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
