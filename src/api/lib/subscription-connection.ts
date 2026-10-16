/**
 * What the guided connect walk is told about one subscription's VPN profile:
 * is it online, and when did it last say so.
 *
 * The panel reads Remnawave live and answers `known` with Remnawave's own two
 * instants and its own clock (`checkedAt`), or `unknown`. This narrows that
 * answer field by field: a panel newer than this cabinet may add fields, and
 * none of them reaches the browser unless it is named here.
 *
 * `unknown` is never a softer "not connected". Anything this side cannot
 * vouch for — a missing field, an instant that does not parse, a body that is
 * not an object — collapses to it, and the walk then asks the customer instead
 * of deciding for them.
 */
export interface SubscriptionConnection {
  readonly state: "known" | "unknown";
  readonly onlineAt: string | null;
  readonly firstConnectedAt: string | null;
  /** The PANEL's clock at the read; `null` when nothing was read. */
  readonly checkedAt: string | null;
}

export const UNKNOWN_CONNECTION: SubscriptionConnection = Object.freeze({
  state: "unknown",
  onlineAt: null,
  firstConnectedAt: null,
  checkedAt: null,
});

/** An instant that parses, as ISO; `undefined` for a value that is present and is not one. */
function instant(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function narrowSubscriptionConnection(answer: unknown): SubscriptionConnection {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return UNKNOWN_CONNECTION;
  const body = answer as Record<string, unknown>;
  if (body["state"] !== "known") return UNKNOWN_CONNECTION;
  const onlineAt = instant(body["onlineAt"]);
  const firstConnectedAt = instant(body["firstConnectedAt"]);
  const checkedAt = instant(body["checkedAt"]);
  // `checkedAt` is what the walk measures "just now" against, so a `known`
  // answer without one is not an answer it can use.
  if (onlineAt === undefined || firstConnectedAt === undefined || checkedAt === undefined || checkedAt === null) {
    return UNKNOWN_CONNECTION;
  }
  return { state: "known", onlineAt, firstConnectedAt, checkedAt };
}
