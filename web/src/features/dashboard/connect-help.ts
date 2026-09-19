/**
 * «Не получилось подключиться?» — what the cabinet reads, and where it sends
 * people, when a subscription was bought and its VPN never connected.
 *
 * Pure, on purpose: the banner, the deep link, the pop-up door and the
 * notification feed all make the same three decisions (is help pending, is the
 * banner due, which card does a link mean), and a decision written into four
 * components is four decisions that drift.
 *
 * ── Where the facts come from ─────────────────────────────────────────────
 *
 * The panel decides, per subscription, and sends the answer on every row of
 * `GET /subscriptions/all` as `connectHelp: { pending, banner } | null`:
 *
 *   pending — help was sent (bot, push, e-mail, the banner or a broadcast) and
 *             the profile has still never connected. What a deep link that
 *             names no subscription picks.
 *   banner  — the help could reach this customer no other way: no bot, no
 *             push, no verified e-mail. Not dismissed, not opted out.
 *
 * A panel older than the feature sends no field, and that must read as "no
 * help pending" everywhere — no banner, no crash, a deep link that simply opens
 * the dashboard's own card. Anything that is not a literal `true` is a "no":
 * a banner raised by a malformed value would be a banner nobody decided to show.
 */
import type { Subscription } from "@/types/api";

export interface ConnectHelpFlags {
  readonly pending: boolean;
  readonly banner: boolean;
}

/** The panel's `connectHelp` for one subscription, or `null` when it said nothing usable. */
export function readConnectHelp(
  subscription: { readonly connectHelp?: unknown } | null | undefined,
): ConnectHelpFlags | null {
  const value = subscription?.connectHelp;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const flags = value as { readonly pending?: unknown; readonly banner?: unknown };
  return { pending: flags.pending === true, banner: flags.banner === true };
}

/**
 * Whether the banner belongs on screen for this card.
 *
 * Only a subscription that is live now: the panel computes the flag for ACTIVE
 * and LIMITED alone, and a list cached from before an expiry must not keep a
 * «подключитесь» card over a subscription that can no longer connect.
 */
export function shouldShowConnectHelpBanner(
  subscription: Pick<Subscription, "id" | "status" | "connectHelp"> | null,
  dismissedIds: ReadonlySet<string>,
): subscription is Pick<Subscription, "id" | "status" | "connectHelp"> {
  if (subscription === null) return false;
  if (subscription.status !== "ACTIVE" && subscription.status !== "LIMITED") return false;
  if (dismissedIds.has(subscription.id)) return false;
  return readConnectHelp(subscription)?.banner === true;
}

/**
 * The list with one subscription's banner switched off, for the query cache.
 *
 * The same object back when there is nothing to change, so a list from a panel
 * without the field is left exactly as it came.
 */
export function withConnectHelpBannerHidden<T>(data: T, subscriptionId: string): T {
  if (data === null || typeof data !== "object") return data;
  const rows = (data as { readonly subscriptions?: unknown }).subscriptions;
  if (!Array.isArray(rows)) return data;
  let changed = false;
  const next = rows.map((row: unknown) => {
    if (row === null || typeof row !== "object") return row;
    const candidate = row as { readonly id?: unknown; readonly connectHelp?: unknown };
    if (candidate.id !== subscriptionId) return row;
    const flags = readConnectHelp(candidate);
    if (flags === null || !flags.banner) return row;
    changed = true;
    return { ...candidate, connectHelp: { ...(candidate.connectHelp as object), banner: false } };
  });
  return changed ? ({ ...(data as object), subscriptions: next } as T) : data;
}

// ─── The deep link ──────────────────────────────────────────────────────────

/**
 * `/dashboard?connect=help[&subscriptionId=…]` — the one address every channel
 * uses: the push click, the bot's «Подключить», the notification feed and the
 * pop-up. One address means one handler, so the operator's door switch is read
 * in one place whichever way the customer arrived.
 */
export const CONNECT_HELP_PARAM = "connect";
export const CONNECT_HELP_VALUE = "help";
export const CONNECT_HELP_SUBSCRIPTION_PARAM = "subscriptionId";

/**
 * A subscription id as the panel mints them (cuid), with room for other id
 * schemes — and nothing that could reshape a path it is put into.
 */
const SUBSCRIPTION_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSubscriptionIdShape(value: unknown): value is string {
  return typeof value === "string" && SUBSCRIPTION_ID_SHAPE.test(value);
}

export function connectHelpDeepLink(subscriptionId: string | null | undefined): string {
  const params = new URLSearchParams({ [CONNECT_HELP_PARAM]: CONNECT_HELP_VALUE });
  if (isSubscriptionIdShape(subscriptionId)) {
    params.set(CONNECT_HELP_SUBSCRIPTION_PARAM, subscriptionId);
  }
  return `/dashboard?${params.toString()}`;
}

export interface ConnectHelpRequest {
  /** The subscription the link named, or `null` — then the pending one is chosen. */
  readonly subscriptionId: string | null;
  /** The address with the two parameters taken out, for a `replace`. */
  readonly cleanedPath: string;
}

/**
 * The request an address carries, or `null` when it carries none.
 *
 * Case-insensitive on the path and tolerant of a trailing slash, because the
 * router matches `/Dashboard/` to the same page and the link must work
 * wherever the page does. A malformed id is dropped rather than refused: the
 * customer still gets help, for the card the fallback picks.
 */
export function readConnectHelpDeepLink(
  pathname: string,
  search: string,
  hash = "",
): ConnectHelpRequest | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path.toLowerCase() !== "/dashboard") return null;
  const params = new URLSearchParams(search);
  if (params.get(CONNECT_HELP_PARAM) !== CONNECT_HELP_VALUE) return null;
  const raw = params.get(CONNECT_HELP_SUBSCRIPTION_PARAM);
  params.delete(CONNECT_HELP_PARAM);
  params.delete(CONNECT_HELP_SUBSCRIPTION_PARAM);
  const rest = params.toString();
  return {
    subscriptionId: isSubscriptionIdShape(raw) ? raw : null,
    cleanedPath: `${pathname}${rest.length > 0 ? `?${rest}` : ""}${hash}`,
  };
}

/**
 * Where somebody who opened the deep link must come back to after signing in
 * — for `?next=` — or `null` when the address is not the deep link.
 *
 * REBUILT from the two parameters it means rather than copied from the
 * address: a `next` names a page, and whatever else the address carried (an
 * ad's `utm_*`, a stray `next` of its own) is carried by the hops that own it,
 * or not at all. The id passes the same shape check as everywhere else, so
 * what comes back is always `/dashboard?connect=help[&subscriptionId=…]`.
 */
export function connectHelpReturnPath(pathname: string, search: string): string | null {
  const request = readConnectHelpDeepLink(pathname, search);
  return request === null ? null : connectHelpDeepLink(request.subscriptionId);
}

function createdAtOf(subscription: Pick<Subscription, "createdAt">): number {
  const at = Date.parse(subscription.createdAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** The newest subscription that is still waiting for help, or `null`. */
export function newestPendingConnectHelp<T extends Pick<Subscription, "id" | "createdAt" | "connectHelp">>(
  subscriptions: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const subscription of subscriptions) {
    if (readConnectHelp(subscription)?.pending !== true) continue;
    if (
      newest === null ||
      createdAtOf(subscription) > createdAtOf(newest) ||
      (createdAtOf(subscription) === createdAtOf(newest) && subscription.id > newest.id)
    ) {
      newest = subscription;
    }
  }
  return newest;
}

/**
 * Which card a deep link means: the one it named, else the newest one still
 * waiting for help, else the card already on screen.
 *
 * A named id that is not in the list is not an error — a subscription deleted
 * since the message went out, a link forwarded from another account — and the
 * fallbacks still land the customer somewhere useful rather than nowhere.
 */
export function pickConnectHelpSubscription<
  T extends Pick<Subscription, "id" | "createdAt" | "connectHelp">,
>(subscriptions: readonly T[], requestedId: string | null, activeId: string | null): T | null {
  if (requestedId !== null) {
    const named = subscriptions.find((subscription) => subscription.id === requestedId);
    if (named !== undefined) return named;
  }
  const pending = newestPendingConnectHelp(subscriptions);
  if (pending !== null) return pending;
  if (activeId !== null) {
    return subscriptions.find((subscription) => subscription.id === activeId) ?? null;
  }
  return null;
}
