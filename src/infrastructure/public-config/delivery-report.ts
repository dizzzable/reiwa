/**
 * What the cabinet tells the panel about the appearance it was just sent:
 * which fields it did NOT take (the per-field fallback kept the previous value
 * for them), so the operator reads it on the branding page itself — the owner's
 * rule of 24.09.2026: «панель пишет, что не принято».
 *
 * The system event on «Журнал аудита» → «Системные события»
 * (`rejection-notifier.ts`) stays; this is the other half, addressed to the
 * page where the value can be fixed. `POST /api/internal/branding/delivery`
 * on the panel keeps the reports and shows the one that belongs to the version
 * the panel serves NOW, so a fixed value (a new version) makes the notice go
 * away and an old report never comes back.
 *
 * One report per panel version per API process: the public config is re-read
 * every minute and after every hint, and the verdict on a version cannot
 * change while the process runs. A version with nothing rejected is reported
 * too — an empty list is how the panel learns the cabinet took all of it.
 * The bot does not read the public config and reports nothing.
 */
import type { PublicConfigFieldRejection } from "../../application/ports/public-config-persistence.port.js";

/** The longest rejected value the report carries; the rest is cut. */
export const MAX_REPORTED_VALUE_LENGTH = 120;

/** One field the cabinet did not take. */
export interface PublicConfigDeliveryField {
  /** The guard's key: `branding.borderRadius`, `branding.navItems[1]`, `customIcons[0]`… */
  readonly path: string;
  /** The guard's reason code, e.g. `not-an-allowed-value`. */
  readonly reason: string;
  /** The value the panel sent there, as JSON, at most `MAX_REPORTED_VALUE_LENGTH` characters. */
  readonly value: string;
}

/** The cabinet's verdict on one version of the panel's public config. */
export interface PublicConfigDeliveryReport {
  /** The panel's version of the payload judged (`config-versions/config-version.ts`). */
  readonly version: string;
  /** What was not taken; empty when everything was. */
  readonly rejected: readonly PublicConfigDeliveryField[];
}

/** Build the report for `incoming`, the panel's payload, and what was rejected in it. */
export function buildPublicConfigDeliveryReport(
  version: string,
  incoming: unknown,
  rejected: readonly PublicConfigFieldRejection[],
): PublicConfigDeliveryReport {
  return {
    version,
    rejected: rejected.map((rejection) => ({
      path: rejection.key,
      reason: rejection.reason,
      value: reportedValue(rejectedValueOf(incoming, rejection)),
    })),
  };
}

/**
 * The value the rejection is about. The guard's key points at it — down to an
 * array entry (`branding.navItems[1]`) — except for the pair check, whose key
 * names no single value; that falls back to the first field of the part.
 */
function rejectedValueOf(incoming: unknown, rejection: PublicConfigFieldRejection): unknown {
  const exact = valueAtPath(incoming, rejection.key);
  if (exact !== undefined) return exact;
  const [field] = rejection.fields;
  return field === undefined ? undefined : valueAtPath(incoming, field);
}

/** `a.b[2].c` → the value there, or `undefined`; own properties only. */
function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(/\.|\[(\d+)\]/).filter((part) => part !== undefined && part !== "")) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** JSON, cut to the limit. A key the panel did not send reads as `(absent)`. */
function reportedValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length <= MAX_REPORTED_VALUE_LENGTH
    ? json
    : `${json.slice(0, MAX_REPORTED_VALUE_LENGTH - 1)}…`;
}

/** Where a report goes; the panel answers 404 when it predates the route. */
export type PublicConfigDeliverySend = (report: PublicConfigDeliveryReport) => Promise<unknown>;

interface DeliveryReporterLogger {
  debug(context: Record<string, unknown>, message: string): void;
}

/**
 * Sends each version's report once. A send that fails is tried again the next
 * time the same version is offered (the next read of the public config); one
 * that succeeds — or that the panel answers at all, including a 404 from a
 * panel without the route — is not sent again. Never throws, never waits.
 */
export class PublicConfigDeliveryReporter {
  private reported: string | null = null;
  private sending: string | null = null;

  public constructor(private readonly logger?: DeliveryReporterLogger) {}

  public offer(report: PublicConfigDeliveryReport, send: PublicConfigDeliverySend): void {
    if (report.version === this.reported || report.version === this.sending) return;
    const version = report.version;
    this.sending = version;
    void Promise.resolve()
      .then(() => send(report))
      .then(
        () => {
          this.reported = version;
        },
        (err: unknown) => {
          if (statusOf(err) === 404) {
            // A panel older than this release: it has nowhere to put the
            // report, and asking again changes nothing.
            this.reported = version;
            return;
          }
          this.logger?.debug(
            { err: err instanceof Error ? err.message : String(err), version },
            "public-config delivery report not sent; it is offered again on the next read",
          );
        },
      )
      .finally(() => {
        if (this.sending === version) this.sending = null;
      });
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}
