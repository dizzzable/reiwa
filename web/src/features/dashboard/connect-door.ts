/**
 * What «Подключить» means — the operator's door switch, decided in one place.
 *
 * The switch «Открывать экран подключения в кабинете» lives in the connect
 * catalog the panel owns (`connectScreenEnabled`, `isConnectScreenEnabled`).
 * On, connecting is the cabinet's own screen; off, it is the subscription's
 * external page — and the off position is the operator's rollback: no deploy,
 * one toggle, back to the page that worked before the screen existed.
 *
 * It used to be read in exactly one place, the dashboard's button. Four things
 * need it now — that button, the banner «Не получилось подключиться?», the
 * pop-up button `@connect` and the deep link `/dashboard?connect=help` — and a
 * fifth copy of "internal or external" is how one of them would come to ignore
 * the switch. So the decision is here, as plain functions, and
 * `use-connect-door.ts` binds it to the dashboard's live query.
 *
 * ── A tap, or no tap ─────────────────────────────────────────────────────
 *
 * The external door opens a new tab, and a new tab is a pop-up: browsers and
 * in-app webviews allow one only while a user gesture is on the stack. A deep
 * link has no gesture — the page was opened BY the link, and anything it does
 * on arrival runs from an effect. `window.open` there is silently swallowed;
 * this cabinet already lost payments to exactly that (`startCheckoutRedirect`
 * in `lib/utils.ts`). So without a tap the external door is never opened: the
 * page points at «Подключить» instead and the customer's own tap opens it.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router";

import { isConnectScreenEnabled } from "@/features/connect/connect-catalog";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import { openExternalUrl } from "@/lib/utils";
import type { AllSubscriptionsResponse, Subscription } from "@/types/api";

import { connectHelpDeepLink, newestPendingConnectHelp } from "./connect-help";

/** The catalog's cache key — shared with the connect screen, which reads the same answer. */
export const CONNECT_PAGE_QUERY_KEY = ["connect-page"] as const;

export type ConnectDoorKind = "internal" | "external";

/** What a door needs to know about the subscription it opens for. */
export type ConnectDoorTarget = Pick<Subscription, "id" | "url">;

/** What happened when nobody tapped. */
export type GesturelessDoorOutcome =
  /** The internal screen was opened. */
  | "navigated"
  /** External: nothing was opened; the caller points the customer at «Подключить». */
  | "highlight"
  /** The switch has not been read yet; nothing was done, ask again once it has. */
  | "waiting";

/**
 * The door, from the catalog the edge returned.
 *
 * `null` while the question is still out: "not answered yet" is not "off", and
 * a caller that can wait (a deep link) must wait rather than decide. A FAILED
 * read is an answer, and the answer is the external page — the switch's safe
 * direction, exactly as `isConnectScreenEnabled` reads a missing catalog.
 */
export function connectDoorKind(catalog: unknown, answered: boolean): ConnectDoorKind | null {
  if (!answered) return null;
  return isConnectScreenEnabled(catalog) ? "internal" : "external";
}

/**
 * The internal screen for one subscription.
 *
 * The id travels with it, as it does for add-ons: a customer can hold several
 * subscriptions, the screen names none of them, and handing over the first in
 * the list would give somebody another subscription's key with nothing on
 * screen to notice it by.
 */
export function connectScreenPath(subscriptionId: string | null | undefined): string {
  return typeof subscriptionId === "string" && subscriptionId.length > 0
    ? `/subscription/connect?subscriptionId=${encodeURIComponent(subscriptionId)}`
    : "/subscription/connect";
}

/**
 * The customer TAPPED something that means "connect this subscription".
 *
 * `null` — the switch not read yet — goes to the external page, which is what
 * this button has always done on a cold start. It is the switch's safe
 * direction: the off position is the rollback, and a tap that bypassed it
 * would land on the very screen an operator had just switched off.
 */
export function openConnectDoorFromTap(
  kind: ConnectDoorKind | null,
  subscription: ConnectDoorTarget | null,
  navigate: NavigateFunction,
): void {
  if (kind === "internal") {
    void navigate(connectScreenPath(subscription?.id));
    return;
  }
  const url = subscription?.url;
  if (url) {
    openExternalUrl(url);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
  }
}

/**
 * Nobody tapped: a deep link, a push click, a message. The internal screen is
 * a navigation and needs no gesture; the external page is NEVER opened from
 * here (see the file header) — the caller highlights «Подключить» instead.
 */
export function openConnectDoorWithoutGesture(
  kind: ConnectDoorKind | null,
  subscription: ConnectDoorTarget,
  navigate: NavigateFunction,
): GesturelessDoorOutcome {
  if (kind === "internal") {
    void navigate(connectScreenPath(subscription.id));
    return "navigated";
  }
  if (kind === "external") return "highlight";
  return "waiting";
}

/**
 * The query cache the dashboard reads through, kept for the pop-up door.
 *
 * The hint controller sits in the shell, above every page, and holds no query
 * and no query-client hook of its own: it must degrade to "no hint" rather than
 * take a page down, and a hook that needs a provider is one more thing that can
 * be missing there. So the dashboard — which owns both reads the door needs,
 * the operator's switch and the subscription list — hands its client over
 * (`useConnectDoor`), and the door reads that cache at the moment of a tap.
 * Before the dashboard has been open there is nothing to read, and the pop-up
 * hands the decision to the dashboard's deep link instead.
 */
let dashboardCache: QueryClient | null = null;

/** Called by the dashboard's door hook; `null` forgets it. */
export function rememberDashboardCache(client: QueryClient | null): void {
  dashboardCache = client;
}

/**
 * The pop-up's button `@connect` — a tap, from a screen that names no card.
 *
 * Whatever the dashboard has already read is used; whatever it has not is left
 * to the dashboard — the deep link `/dashboard?connect=help` waits for the
 * switch and the list and then does the same thing.
 *
 * The subscription is the newest one still waiting for help (the pop-up is
 * raised for exactly that), else the dashboard's own card.
 */
export function openConnectDoorForHint(
  navigate: NavigateFunction,
  client: QueryClient | null = dashboardCache,
): void {
  const catalog = client?.getQueryState(CONNECT_PAGE_QUERY_KEY);
  const kind = connectDoorKind(catalog?.data, catalog !== undefined && catalog.status !== "pending");
  const rows = client?.getQueryData<AllSubscriptionsResponse>(subscriptionQueryKeys.all)?.subscriptions;
  const pending = Array.isArray(rows) ? newestPendingConnectHelp(rows) : null;

  if (pending !== null && kind === "internal") {
    void navigate(connectScreenPath(pending.id));
    return;
  }
  if (pending !== null && kind === "external" && pending.url) {
    // Inside the tap, so the new tab is allowed.
    openConnectDoorFromTap(kind, pending, navigate);
    return;
  }
  void navigate(connectHelpDeepLink(pending?.id ?? null));
}
