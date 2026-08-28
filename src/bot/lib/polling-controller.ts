import type { Bot, Context } from 'grammy';

/**
 * Telegram polling, as a thing a shutdown can stop.
 *
 * Extracted from `main.ts` rather than left inline, and the reason is the same
 * one that makes it worth having: `main.ts` calls `startBot()` at module load
 * with no entry guard, so nothing in it can be imported by a test. What lived
 * there was a money-bearing loop — it decides whether a debited Stars payment
 * survives a restart — and it was unreachable by any assertion.
 */

/**
 * The slice of the process logger this file uses, in pino's own shape: either
 * a message alone or a context object plus a message.
 */
export interface PollingLogger {
  readonly info: (objOrMsg: object | string, msg?: string) => void;
  readonly warn: (objOrMsg: object | string, msg?: string) => void;
}

/**
 * Structurally what `main.ts` builds. Declared here rather than imported
 * because the bot's context type is defined inside `main.ts`, which cannot be
 * imported without starting the bot — the very reason this file exists.
 */
type PollingBot = Pick<Bot<Context>, 'start' | 'stop'>;

/**
 * The polling loop, plus the two things a shutdown needs from it.
 *
 * ── WHY `stop()` AWAITS THE LOOP, AND WHAT WAS LOST WITHOUT IT ───────────
 *
 * grammY records an update as tried BEFORE it awaits the handler, and
 * `bot.stop()` then commits that offset to Telegram — an acknowledgement
 * that says "delivered, do not send it again". The promise returned by
 * `bot.start()` is what resolves once the middleware stack has actually
 * finished; nothing held it, so shutdown called `stop()` and the process
 * exited while a handler was still running.
 *
 * For an ordinary message that costs a reply. For `successful_payment` it
 * costs the payment: the stars are debited, the forward to the panel is
 * abandoned mid-retry, Telegram has been told not to redeliver, and the
 * ERROR line that exists to hand an operator the charge id never runs
 * either. Awaiting the loop is what turns "killed halfway" into "finished
 * or reported".
 *
 * ── WHY THE RETRY LOOP NEEDS A FLAG ─────────────────────────────────────
 *
 * `bot.stop()` on a bot that is between attempts logs "Bot is not running!"
 * and returns instantly. The backoff then elapses inside the remaining
 * shutdown budget, `while (true)` comes round, and `bot.start()` RE-TAKES
 * the polling slot — which `process.exit` then abandons uncleanly. That is
 * precisely the stale-slot state, and the 409 on the next boot, that this
 * loop exists to avoid.
 */
export function createPollingController(
  bot: PollingBot,
  logger: PollingLogger,
  /** Called once, after the first poll starts — the startup banner. */
  onFirstStart?: () => void,
): { run: () => Promise<void>; stop: () => Promise<void> } {
  let stopping = false;
  let loop: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    loop = runPollingLoop(bot, logger, () => stopping, onFirstStart);
    await loop;
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await bot.stop();
    // The drain. `bot.start()` resolves when the middleware stack is done,
    // so this is the only point at which "the last handler finished" is
    // observable. Bounded by the caller's shutdown budget, never here — a
    // deadline belongs with the policy that owns the whole sequence.
    if (loop !== null) await loop;
  };

  return { run, stop };
}

async function runPollingLoop(
  bot: PollingBot,
  logger: PollingLogger,
  isStopping: () => boolean,
  onFirstStart?: () => void,
): Promise<void> {
  let attempt = 0;
  // Maximum interval between retries (5 minutes). Telegram's stale
  // polling slots clear in ~30s; anything longer is paranoia.
  const MAX_BACKOFF_MS = 5 * 60 * 1000;

  while (true) {
    try {
      await bot.start({
        // NEVER. This was `attempt === 0` — "reset the offset cleanly on
        // cold start" — and a cold start is exactly when the backlog is
        // most likely to hold something that must not be dropped.
        //
        // The bot is the ONLY consumer of Telegram payment updates: one
        // long-poll slot per token, and `message:successful_payment` is
        // handled here. A buyer whose stars were debited seconds before a
        // deploy had their `successful_payment` discarded by the restart,
        // and with the update gone the handler's own "payment NOT recorded"
        // ERROR — the line that hands an operator the charge id — never
        // fired either. Charged, nothing delivered, no local trace.
        //
        // Dropping never solved the 409 this loop is about; the retry does.
        // What it bought was a quiet start after a long outage, and the
        // price of that quiet is a lost payment. A noisy catch-up is
        // recoverable; a silently discarded charge is not.
        drop_pending_updates: false,
        // Short timeout means we cycle through getUpdates more often,
        // which gives us more chances to win the polling slot when a
        // rogue / staging deployment is competing for the same token.
        // 5 seconds is the sweet spot: long enough that Telegram's
        // long-poll mechanism still saves us most of the round-trips,
        // short enough that we'll grab the slot within ~5s of a rival
        // releasing it. Default would be 30s.
        timeout: 5,
        onStart: (info) => {
          logger.info(
            { username: info.username, attempt },
            attempt === 0 ? 'reiwa-bot started' : 'reiwa-bot resumed polling',
          );
          // Success banner — printed once, on the first successful poll start.
          if (attempt === 0) onFirstStart?.();
        },
      });
      // bot.start() returns when the polling loop terminates cleanly
      // (e.g. .stop() called). Treat that as a graceful shutdown rather
      // than reconnect-on-success.
      logger.info('reiwa-bot polling loop exited cleanly');
      return;
    } catch (err: unknown) {
      // A failure DURING shutdown is not something to race back from: the
      // slot we would re-take is one we are about to abandon.
      if (isStopping()) {
        logger.info({ err }, 'reiwa-bot polling stopped during shutdown');
        return;
      }
      attempt += 1;
      // Aggressive race-back-in strategy: the first 5 attempts use a
      // short fixed delay (200ms) so we re-enter Telegram's polling
      // queue almost immediately after losing the slot. After that we
      // fall back to exponential backoff up to 5 minutes — this only
      // kicks in if the rogue poller is permanently winning, in which
      // case spamming Telegram won't help us.
      const isFastRetry = attempt <= 5;
      const backoffMs = isFastRetry
        ? 200
        : Math.min(2_000 * 2 ** Math.min(attempt - 6, 7), MAX_BACKOFF_MS);
      logger.warn(
        { err, attempt, backoffMs },
        'bot.start() failed — retrying after backoff',
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      // Checked again AFTER the backoff, because the signal usually arrives
      // during it. Without this the loop re-enters `bot.start()` inside the
      // shutdown window and takes a polling slot nothing will release.
      if (isStopping()) {
        logger.info('reiwa-bot polling loop not resuming: shutdown in progress');
        return;
      }
    }
  }
}
