/**
 * The version heartbeat: reiwa-api tells the panel which release is running
 * (`POST /api/internal/system/reiwa-version {version}`), at start and then
 * every hour. The panel's «Обновления» widget shows it, and panel 0.9.7.71
 * also keeps it as evidence of which cabinet it serves.
 *
 * ── Why the one at start is retried (review R1-05, 26.09.2026) ─────────────
 *
 * The heartbeat at start is what replaces the previous release's record on the
 * panel after an update. It used to be sent once, with the failure logged at
 * debug and the next one an hour later. A panel that could not be reached at
 * that moment (a host reboot, one script restarting both stacks) kept the
 * previous release's record for up to 65 minutes. Panel 0.9.7.71 decides from
 * that record whether this cabinet can show the top-up «до сброса», so the
 * record held the offer back and sent a false «🧩 Кабинет старше панели» card.
 * After a rollback it did the reverse: it SOLD the offer to an older cabinet.
 *
 * So the heartbeat at start is sent again until the panel takes it: after 5 s,
 * then twice as long each time, never more than 5 min apart. After that it goes
 * hourly, exactly as before: an hourly one that fails waits for the next hour.
 *
 *  - It never holds up the start: nothing awaits it, and its timers are
 *    unref'd.
 *  - A refusal is not an outage. A 4xx other than 404, 408 and 429 means the
 *    panel got the call and said no: a token it does not accept, a version its
 *    DTO rejects. Asking again gets the same answer, so it is said once, at
 *    warn, and the heartbeat goes hourly. A 404 (a panel still starting, or a
 *    proxy in front of one), 408 (the panel's own request timeout), 429, a
 *    5xx, and no answer at all are all worth asking again soon.
 *  - `stop()` ends it. A shutdown sends nothing more, and an attempt still in
 *    flight schedules nothing when it lands.
 */
import type { LoggerPort } from '../application/ports/logger.port.js';
import { UpstreamError } from '../core/errors/index.js';

export const VERSION_HEARTBEAT_INTERVAL_MS = 60 * 60_000;
export const VERSION_HEARTBEAT_FIRST_RETRY_MS = 5_000;
export const VERSION_HEARTBEAT_MAX_RETRY_MS = 5 * 60_000;
/** An attempt with no answer by then counts as failed. undici gives up sooner (10 s for headers); this is the backstop. */
export const VERSION_HEARTBEAT_TIMEOUT_MS = 30_000;

/** 4xx answers that do not mean "the panel refuses this". */
const ASK_AGAIN_STATUSES: ReadonlySet<number> = new Set([404, 408, 429]);

/** Whether the panel got the heartbeat and refused it: asking again gets the same answer. */
export function isHeartbeatRefusal(err: unknown): boolean {
  return err instanceof UpstreamError && err.status >= 400 && err.status < 500 && !ASK_AGAIN_STATUSES.has(err.status);
}

export interface VersionHeartbeatOptions {
  /** One heartbeat: `adminClient.system.reportReiwaVersion(REIWA_VERSION)`. */
  readonly send: () => Promise<unknown>;
  readonly logger?: LoggerPort;
  readonly intervalMs?: number;
  readonly firstRetryMs?: number;
  readonly maxRetryMs?: number;
  readonly timeoutMs?: number;
}

export interface VersionHeartbeat {
  /** No more heartbeats, and no retry. Safe to call more than once. */
  stop(): void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Send the first heartbeat now, and keep sending by the rules in the header. Returns at once. */
export function startVersionHeartbeat(options: VersionHeartbeatOptions): VersionHeartbeat {
  const intervalMs = options.intervalMs ?? VERSION_HEARTBEAT_INTERVAL_MS;
  const maxRetryMs = options.maxRetryMs ?? VERSION_HEARTBEAT_MAX_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? VERSION_HEARTBEAT_TIMEOUT_MS;
  const logger = options.logger;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  /** Until the panel has taken one heartbeat, or refused one. */
  let starting = true;
  let nextRetryMs = options.firstRetryMs ?? VERSION_HEARTBEAT_FIRST_RETRY_MS;
  let failedAtStart = 0;
  let refusalSaid = false;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      timer = null;
      void beat();
    }, delayMs);
    timer.unref?.();
  };

  /** One attempt: `null` when the panel took it, the error otherwise. Never rejects, even when `send` throws. */
  const attempt = async (): Promise<{ readonly err: unknown } | null> => {
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        options.send(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
          deadline.unref?.();
        }),
      ]);
      return null;
    } catch (err: unknown) {
      return { err };
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  };

  const beat = async (): Promise<void> => {
    const failure = await attempt();
    // Stopped while this one was in flight: nothing more, not even a log line.
    // The only guard: every later step is below it, and `stop()` clears the
    // one timer that could fire.
    if (stopped) return;

    if (failure === null) {
      if (starting && failedAtStart > 0) {
        logger?.info({ attempts: failedAtStart + 1 }, 'reiwa version heartbeat: the panel took it after it failed at start');
      }
      starting = false;
      schedule(intervalMs);
      return;
    }

    const refused = isHeartbeatRefusal(failure.err);
    // The retry condition: only the heartbeat at start, and only when the
    // panel did not refuse it.
    const retry = starting && !refused;
    if (refused) {
      const status = (failure.err as UpstreamError).status;
      if (!refusalSaid) {
        refusalSaid = true;
        logger?.warn(
          { err: describe(failure.err), status },
          'reiwa version heartbeat: the panel refuses it; not asked again until the hourly one',
        );
      } else {
        logger?.debug({ err: describe(failure.err), status }, 'reiwa version heartbeat refused again');
      }
    }
    if (retry) {
      failedAtStart += 1;
      const waitMs = nextRetryMs;
      nextRetryMs = Math.min(nextRetryMs * 2, maxRetryMs);
      logger?.debug(
        { err: describe(failure.err), attempt: failedAtStart, retryInMs: waitMs },
        'reiwa version heartbeat failed at start; asking again',
      );
      schedule(waitMs);
      return;
    }
    if (!refused) logger?.debug({ err: describe(failure.err) }, 'reiwa version heartbeat failed');
    starting = false;
    schedule(intervalMs);
  };

  void beat();
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
