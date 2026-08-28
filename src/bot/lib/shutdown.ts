/**
 * Graceful shutdown for the bot process.
 *
 * Until this existed the bot had NO signal handler at all, so `docker stop`
 * killed it mid-`getUpdates` via Node's default disposition. That is not just a
 * missing farewell message — it is the cause of a problem the polling loop
 * already spends effort papering over:
 *
 *   > Telegram allows only ONE long-poll consumer per token. When a previous
 *   > reiwa-bot instance crashes mid-getUpdates, Telegram keeps the stale
 *   > polling slot alive for ~30 seconds […]
 *
 * That comment describes a crash. With no handler, EVERY ordinary restart was
 * one, so the retry/backoff loop was fighting a ghost this process created
 * itself. Calling `bot.stop()` releases the slot and commits the update offset,
 * which is why the stop runs BEFORE the notice: the notice is best-effort, the
 * slot has a consequence that outlives us.
 *
 * Timing is not advisory here. No `stop_grace_period` is configured anywhere in
 * the compose files, so Docker's implicit default applies: SIGTERM, then
 * SIGKILL ten seconds later — so the bot service sets `stop_grace_period: 60s`.
 * Every step is bounded, and the budgets add up to less than the grace with
 * room to spare — an unbounded `await` on a network call would simply be
 * killed halfway, which is the behaviour we set out to remove.
 *
 * Deliberately NOT covered: crashes. `uncaughtException` exits through
 * `process-guards`, not through a signal, so no farewell is sent for one. That
 * asymmetry is the point — a farewell means "someone stopped me", and a
 * message that also appeared on every crash would stop carrying that meaning.
 */

/**
 * Bound on releasing the Telegram polling slot AND draining the handler still
 * running behind it.
 *
 * Three seconds was a bound on `bot.stop()` alone, which returns almost at
 * once. It now also covers the drain, and the drain has to outlast the longest
 * thing a handler does: forwarding a Stars payment to the panel, which retries
 * four times against a ten-second transport timeout with backoff — about
 * forty-two seconds in the worst case. A budget shorter than that abandons the
 * forward after Telegram has already been told the update was delivered, which
 * is a debited payment with no record anywhere.
 *
 * It costs nothing in the ordinary case: the drain resolves the moment the
 * middleware stack is empty, so a bot with nothing in flight still stops in
 * milliseconds. Only a shutdown that lands on a payment pays the seconds, and
 * that is exactly the shutdown worth waiting for.
 *
 * `stop_grace_period: 60s` on the bot service is what makes the budget real —
 * Docker's implicit default is ten seconds, and a budget larger than the grace
 * is a number the SIGKILL ignores.
 */
const DRAIN_BUDGET_MS = 45_000;
/** Bound on closing the internal HTTP listener. */
const STOP_BUDGET_MS = 3_000;
/** Bound on the operator notice. Best-effort by design. */
const NOTICE_BUDGET_MS = 4_000;

export interface BotShutdownSteps {
  /** Release the Telegram polling slot and commit the update offset. */
  readonly stopPolling: () => Promise<void>;
  /** Operator-facing farewell. Never allowed to fail the shutdown. */
  readonly farewell: (signal: string, uptimeMs: number) => Promise<void>;
  /** Background timers to cancel before anything else. */
  readonly clearTimers: () => void;
  /** Internal HTTP listener, when one was started. */
  readonly closeServer: (() => Promise<void>) | null;
  readonly logger: {
    readonly info: (obj: object, msg: string) => void;
    readonly warn: (obj: object, msg: string) => void;
  };
  /** Injected so a test can drive uptime without waiting for a clock. */
  readonly now?: () => number;
  readonly startedAt: number;
}

/**
 * Runs a step under a deadline. Resolves either way: a step that overruns is
 * reported and abandoned, never awaited into the SIGKILL.
 *
 * The overrun path leaves the underlying promise running. That is intentional —
 * the process is about to exit, and there is nothing useful to cancel.
 */
async function withinBudget(
  label: string,
  budgetMs: number,
  run: () => Promise<void>,
  logger: BotShutdownSteps['logger'],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  try {
    const outcome = await Promise.race([
      run().then(
        () => 'done' as const,
        (err: unknown) => ({ err }),
      ),
      deadline,
    ]);
    if (outcome === 'timeout') {
      logger.warn({ step: label, budgetMs }, 'bot/shutdown: step exceeded its budget');
    } else if (outcome !== 'done') {
      logger.warn({ step: label, err: outcome.err }, 'bot/shutdown: step failed');
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The shutdown sequence itself, free of `process` so it can be driven directly
 * by a test.
 */
export async function runBotShutdown(
  signal: string,
  steps: BotShutdownSteps,
): Promise<void> {
  const { logger } = steps;
  const now = steps.now ?? Date.now;
  const uptimeMs = Math.max(0, now() - steps.startedAt);
  logger.info({ signal, uptimeMs }, 'reiwa-bot shutting down');

  // First, because it is synchronous and stops anything new from starting.
  steps.clearTimers();

  // Second, because this is the step with a consequence outside this process.
  await withinBudget('stopPolling', DRAIN_BUDGET_MS, steps.stopPolling, logger);

  // Third — by now the slot is free, so a slow send costs nothing but our own
  // remaining seconds.
  await withinBudget('farewell', NOTICE_BUDGET_MS, () => steps.farewell(signal, uptimeMs), logger);

  if (steps.closeServer !== null) {
    await withinBudget('closeServer', STOP_BUDGET_MS, steps.closeServer, logger);
  }

  logger.info({ signal }, 'reiwa-bot stopped');
}

/**
 * Registers SIGTERM/SIGINT once.
 *
 * The re-entrancy guard is not decoration: Docker sends SIGTERM and an
 * impatient operator sends Ctrl-C, and a second pass would call `bot.stop()` on
 * an already-stopped bot and send the farewell twice.
 */
export function installBotShutdownHandlers(
  steps: BotShutdownSteps,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let shuttingDown = false;
  const handle = (signal: string): void => {
    if (shuttingDown) {
      steps.logger.info({ signal }, 'bot/shutdown: already in progress, ignoring signal');
      return;
    }
    shuttingDown = true;
    void runBotShutdown(signal, steps).then(
      () => exit(0),
      // `runBotShutdown` swallows step failures, so reaching here means the
      // sequence itself broke. Exit anyway — refusing to stop is worse.
      (err: unknown) => {
        steps.logger.warn({ signal, err }, 'bot/shutdown: sequence failed');
        exit(0);
      },
    );
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
