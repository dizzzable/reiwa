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
 *
 * Since 24.09.2026 a fresh panel payload is judged field by field
 * (`field-fallback.ts`): only a payload unusable as a whole is `rejected`;
 * one with bad fields is taken without them, `fieldsRejected` names every
 * field, and `delivery-report.ts` tells the branding page the same.
 */
import type { LoggerPort } from "../../application/ports/logger.port.js";
import type { PublicConfigRejection } from "../../application/ports/public-config-persistence.port.js";
import { ReiwaSystemEventType } from "../../core/enums/system-event-type.enum.js";
import { formatCopySize } from "../config-versions/last-known-good.js";
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
  /** The (first) key it is about, for the recovery line. */
  readonly key: string;
  readonly firstSeenAt: number;
  lastNotifiedAt: number;
  suppressed: number;
}

export interface PublicConfigRejectionNotifier {
  /**
   * Record a rejected snapshot — nothing in it was taken. Emits on the first
   * occurrence of a cause, on any change of cause, and then at most once per
   * `REMINDER_MS`.
   */
  rejected(source: PublicConfigRejectionSource, rejection: PublicConfigRejection): void;
  /**
   * Record a snapshot taken WITHOUT some of its fields: everything else in it
   * is live, and each of these keeps the previously served value
   * (`field-fallback.ts`). Same schedule as `rejected`; the cause is the set
   * of fields and reasons, so a different set is reported at once.
   */
  fieldsRejected(
    source: PublicConfigRejectionSource,
    rejections: readonly PublicConfigRejection[],
  ): void;
  /** Record that this source produced a usable snapshot again. */
  accepted(source: PublicConfigRejectionSource): void;
  /**
   * Record that the copy a restart serves was NOT updated: this snapshot is
   * over the saved-copy cap (`config-versions/last-known-good.ts`), so Redis
   * keeps an older copy, or none. Customers see the new appearance now; a
   * restart during a panel outage would serve the older one. Once per version,
   * with the size — it used to be a log line on every save, one a minute
   * (review R2a-07).
   */
  copyNotSaved(skipped: PublicConfigCopyNotSaved): void;
}

/** A public-config snapshot the saved copy was not updated with, and why. */
export interface PublicConfigCopyNotSaved {
  /** The panel version of the snapshot not saved. */
  readonly version: string;
  readonly bytes: number;
  readonly maxBytes: number;
}

/** `bytes` as an operator reads it on a Russian card: `5,3 МБ`. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
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
  /** The version whose unsaved copy was last reported: once per version. */
  let copyNotSavedReported: string | null = null;

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

  /**
   * The system event for fields that were not taken. It names every one of
   * them — key, reason, what was there — and says what customers see: the
   * rest of the new appearance, with the previous value of these fields.
   */
  const emitFields = (
    source: PublicConfigRejectionSource,
    rejections: readonly PublicConfigRejection[],
    state: ActiveRejection,
    repeat: boolean,
    at: number,
  ): void => {
    const heldForMs = at - state.firstSeenAt;
    const named = rejections
      .map((rejection) => `"${rejection.key}" (${rejection.reason}, found ${rejection.found})`)
      .join("; ");
    const count = rejections.length === 1 ? "1 field" : `${rejections.length} fields`;
    const message = repeat
      ? `Public config still applied without ${count}: ${named} — for ${Math.round(heldForMs / 60_000)} min customers have seen the previous value of ${rejections.length === 1 ? "this field" : "these fields"}, and everything else as saved`
      : `Public config applied without ${count}: ${named} — everything else is live; customers keep seeing the previous value of ${rejections.length === 1 ? "this field" : "these fields"} until ${rejections.length === 1 ? "it is" : "they are"} fixed`;

    const [first] = rejections;
    const context = {
      event: ReiwaSystemEventType.CONFIG_DEGRADED_DEFAULTS_USED,
      source,
      key: first?.key,
      reason: first?.reason,
      found: first?.found,
      fields: rejections.map(({ key, reason, found }) => ({ key, reason, found })),
      frozenForMs: heldForMs,
      suppressedRepeats: state.suppressed,
    };

    log?.warn(context, message);
    errorReporter?.report({ level: "warning", message, context });
  };

  /**
   * One suppression schedule for both kinds of report: the first occurrence
   * of a cause and every change of cause are reported at once, a repeat at
   * most once per `REMINDER_MS`.
   */
  const track = (
    source: PublicConfigRejectionSource,
    fingerprint: string,
    key: string,
    report: (state: ActiveRejection, repeat: boolean, at: number) => void,
  ): void => {
    const at = clock();
    const current = active.get(source);

    if (current !== undefined && current.fingerprint === fingerprint) {
      current.suppressed += 1;
      if (at - current.lastNotifiedAt < REMINDER_MS) return;
      current.lastNotifiedAt = at;
      report(current, true, at);
      current.suppressed = 0;
      return;
    }

    const state: ActiveRejection = {
      fingerprint,
      key,
      firstSeenAt: at,
      lastNotifiedAt: at,
      suppressed: 0,
    };
    active.set(source, state);
    report(state, false, at);
  };

  return {
    rejected(source, rejection): void {
      // Fingerprint on key + reason only. The offending value may wobble
      // between polls (a colour being edited, a growing list) while the cause
      // is unchanged; including it would re-alert on every poll and defeat
      // the suppression. A genuinely different cause changes the fingerprint
      // and is reported at once.
      track(source, `${rejection.key}|${rejection.reason}`, rejection.key, (state, repeat, at) =>
        emit(source, rejection, state, repeat, at),
      );
    },

    fieldsRejected(source, rejections): void {
      if (rejections.length === 0) return;
      // The same rule as above, over the whole set: which keys, for which
      // reasons — never the values.
      const fingerprint = `fields:${rejections
        .map((rejection) => `${rejection.key}|${rejection.reason}`)
        .sort()
        .join(",")}`;
      track(source, fingerprint, rejections[0]?.key ?? "", (state, repeat, at) =>
        emitFields(source, rejections, state, repeat, at),
      );
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
          key: current.key,
          frozenForMs: clock() - current.firstSeenAt,
        },
        "Public config snapshot accepted again — the cabinet appearance is live",
      );
    },

    copyNotSaved(skipped): void {
      if (copyNotSavedReported === skipped.version) return;
      copyNotSavedReported = skipped.version;
      const message =
        `Public config copy not saved: ${formatCopySize(skipped.bytes)} is over the ` +
        `${formatCopySize(skipped.maxBytes)} cap — customers see the new appearance, but a restart ` +
        "during a panel outage serves the older saved copy (or none)";
      const context = {
        event: ReiwaSystemEventType.CONFIG_COPY_NOT_SAVED,
        group: "public-config",
        version: skipped.version,
        bytes: skipped.bytes,
        maxBytes: skipped.maxBytes,
        // Russian, for the panel's card («💡 Почему»).
        why:
          `Оформление кабинета весит ${megabytes(skipped.bytes)} — больше предела ` +
          `${megabytes(skipped.maxBytes)} для его копии в Redis кабинета, поэтому копия не обновлена. ` +
          "Клиенты видят новое оформление, но если кабинет перезапустится, пока панель недоступна, " +
          "он покажет прежнюю сохранённую копию (или стандартное оформление, если копии нет). " +
          "Уменьшите оформление: картинки, загруженные прямо в поля, и количество своих иконок.",
      };
      log?.warn(context, message);
      errorReporter?.report({ level: "warning", message, context });
    },
  };
}
