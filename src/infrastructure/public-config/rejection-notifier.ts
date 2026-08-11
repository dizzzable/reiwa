/**
 * Operator-visible reporting for rejected public-config snapshots.
 *
 * A rejected snapshot is not a crash and not a request failure, so nothing in
 * the request path ever surfaced it. The cabinet simply went on serving the
 * previous snapshot — the edge from Redis, the browser from localStorage —
 * while the panel showed the new theme and reported the save as successful.
 * The appearance stayed frozen for as long as the offending key survived, and
 * the only trace was a generic "background refresh failed" line.
 *
 * This routes the rejection two ways:
 *   - a `warn` log line that names the key and states the consequence;
 *   - a `warning`-level report through the existing `ErrorReporter`, i.e.
 *     `POST /api/internal/system/error` -> the rezeis audit log -> the Events
 *     page, which is where operators already look for reiwa-side trouble.
 *
 * The `event` field carries `ReiwaSystemEventType.CONFIG_DEGRADED_DEFAULTS_USED`
 * so operators can filter or route on a stable identifier instead of matching
 * free text. No new transport is introduced and nothing new is configurable —
 * the thresholds below are constants on purpose.
 */
import type { LoggerPort } from "../../application/ports/logger.port.js";
import type { PublicConfigRejection } from "../../application/ports/public-config-persistence.port.js";
import { ReiwaSystemEventType } from "../../core/enums/system-event-type.enum.js";
import type { ErrorReporter } from "../error-reporter/index.js";

/** Which read path rejected the snapshot. */
export type PublicConfigRejectionSource =
  /** Fresh payload from rezeis-admin. */
  | "upstream"
  /** Durable last-known-good snapshot read back from Redis. */
  | "redis-load"
  /** Snapshot offered for persistence. */
  | "redis-save";

/**
 * Re-assert a still-unfixed rejection at most this often.
 *
 * The public-config cache has a 60s TTL, so an unattended bad key produces a
 * rejection every minute — 1440 identical lines a day, which is how the
 * original defect stayed invisible even once it was logged. Thirty minutes is
 * chosen against that TTL: it collapses 30 polls into one line, so a shift's
 * worth of logs still shows the condition several times over (an operator
 * scanning any half-hour window sees it) while a week-long freeze costs ~48
 * lines a day instead of ~1440. It is a constant rather than a setting
 * because every reiwa knob lives in the panel and this one is not worth one.
 */
const REMINDER_MS = 30 * 60_000;

interface ActiveRejection {
  /** Key + reason, deliberately excluding the value — see `rejected`. */
  readonly fingerprint: string;
  readonly firstSeenAt: number;
  lastNotifiedAt: number;
  suppressed: number;
}

export interface PublicConfigRejectionNotifier {
  /**
   * Record a rejected snapshot. Emits on the first occurrence of a cause, on
   * any change of cause, and then at most once per `REMINDER_MS`.
   */
  rejected(source: PublicConfigRejectionSource, rejection: PublicConfigRejection): void;
  /** Record that this source produced a usable snapshot again. */
  accepted(source: PublicConfigRejectionSource): void;
}

export function createPublicConfigRejectionNotifier(opts: {
  readonly logger?: LoggerPort | undefined;
  readonly errorReporter?: ErrorReporter | undefined;
  /** Injectable clock; tests drive the reminder window with it. */
  readonly now?: () => number;
}): PublicConfigRejectionNotifier {
  const log = opts.logger?.child({ component: "public-config-guard" });
  const errorReporter = opts.errorReporter;
  const clock = opts.now ?? Date.now;
  const active = new Map<PublicConfigRejectionSource, ActiveRejection>();

  const emit = (
    source: PublicConfigRejectionSource,
    rejection: PublicConfigRejection,
    state: ActiveRejection,
    repeat: boolean,
    at: number,
  ): void => {
    const frozenForMs = at - state.firstSeenAt;
    const message = repeat
      ? `Public config snapshot still rejected at "${rejection.key}" (${rejection.reason}, found ${rejection.found}) — the cabinet has been serving the previous snapshot for ${Math.round(frozenForMs / 60_000)} min; its appearance stays frozen until this key is fixed`
      : `Public config snapshot rejected at "${rejection.key}" (${rejection.reason}, found ${rejection.found}) — the cabinet keeps serving the previous snapshot; its appearance is frozen until this key is fixed`;

    const context = {
      event: ReiwaSystemEventType.CONFIG_DEGRADED_DEFAULTS_USED,
      source,
      key: rejection.key,
      reason: rejection.reason,
      found: rejection.found,
      frozenForMs,
      suppressedRepeats: state.suppressed,
    };

    log?.warn(context, message);
    errorReporter?.report({ level: "warning", message, context });
  };

  return {
    rejected(source, rejection): void {
      // Fingerprint on key + reason only. The offending value may wobble
      // between polls (a colour being edited, a growing list) while the cause
      // is unchanged; including it would re-alert on every poll and defeat
      // the suppression. A genuinely different cause changes the fingerprint
      // and is reported at once.
      const fingerprint = `${rejection.key}|${rejection.reason}`;
      const at = clock();
      const current = active.get(source);

      if (current !== undefined && current.fingerprint === fingerprint) {
        current.suppressed += 1;
        if (at - current.lastNotifiedAt < REMINDER_MS) return;
        current.lastNotifiedAt = at;
        emit(source, rejection, current, true, at);
        current.suppressed = 0;
        return;
      }

      const state: ActiveRejection = {
        fingerprint,
        firstSeenAt: at,
        lastNotifiedAt: at,
        suppressed: 0,
      };
      active.set(source, state);
      emit(source, rejection, state, false, at);
    },

    accepted(source): void {
      const current = active.get(source);
      if (current === undefined) return;
      active.delete(source);
      // Log-only on purpose: recovery is not a warning, and `ErrorReporter`
      // has no level for it. The operator looks here after fixing the key,
      // and the reminders simply stop.
      log?.info(
        {
          event: ReiwaSystemEventType.CONFIG_DEGRADED_DEFAULTS_USED,
          source,
          key: current.fingerprint.split("|")[0],
          frozenForMs: clock() - current.firstSeenAt,
        },
        "Public config snapshot accepted again — the cabinet appearance is live",
      );
    },
  };
}
