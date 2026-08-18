import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { isTelegramMiniAppSurface } from "./telegram-launch-params";

export { brandAuroraStops } from "./brand-colors";

/**
 * shadcn/ui-canonical class merger.
 * Combines `clsx` (conditional className composition) with `tailwind-merge`
 * (deduplication of conflicting Tailwind utilities — e.g. `p-2 p-4` → `p-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats an ISO date string as a compact numeric date: `DD.MM.YY` (e.g. `15.05.26`).
 * Used on the subscription card where space is limited.
 */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}.${month}.${year}`;
}

/**
 * Formats an ISO date-time string as a localised short date + time
 * (e.g. "23 окт, 14:30").
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(getActiveLocale(), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Returns the integer number of full days between now and `value`.
 * Negative when the date has already passed, zero on the exact day.
 */
export function getDaysLeft(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const target = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(target.getTime())) return 0;
  const now = Date.now();
  return Math.ceil((target.getTime() - now) / (24 * 60 * 60 * 1000));
}

function getActiveLocale(): string {
  const htmlLang = document.documentElement.lang;
  if (htmlLang && htmlLang.length > 0) return htmlLang;
  return "ru";
}

type TelegramWebApp = NonNullable<NonNullable<Window["Telegram"]>["WebApp"]>;

/** Which of Telegram's three "open" bridges a URL has to be handed to. */
export type TelegramLinkKind = "invoice" | "telegram" | "external";

/**
 * Telegram's own invoice-link shape, copied from `telegram-web-app.js`:
 * `/$<slug>` or `/invoice/<slug>` on `t.me`. `openInvoice` rejects anything
 * else with `WebAppInvoiceUrlInvalid`, so the test has to be this exact.
 */
const TELEGRAM_INVOICE_PATH = /^\/(\$|invoice\/)[A-Za-z0-9_=-]+$/;

/**
 * Classifies a URL by which Telegram bridge call can open it.
 *
 * THE SINGLE COPY OF THIS RULE. It used to exist twice — as a regex in
 * `openExternalUrl` and as "everything goes to `openLink`" in
 * `startCheckoutRedirect` — and the two disagreed, which is precisely how
 * Telegram Stars checkouts stopped opening.
 *
 * The distinction is not cosmetic; the bridge validates and throws:
 *   - `invoice`  — `https://t.me/$<slug>`, exactly what Bot API
 *     `createInvoiceLink` returns and therefore what the Telegram Stars
 *     gateway hands back as `checkoutUrl`. Only `openInvoice` raises the
 *     native payment sheet; `openLink` would render the t.me *landing page*
 *     in the in-app browser, where nobody can pay.
 *   - `telegram` — any other `t.me` deep link (CryptoPay returns
 *     `https://t.me/CryptoBot?start=…`) or a `tg:` link. `openTelegramLink`
 *     lets the client resolve it natively.
 *   - `external` — ordinary gateway checkout pages. `openLink` (in-app
 *     browser) is right for these and the other two would throw.
 */
export function classifyTelegramLink(url: string): TelegramLinkKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not parseable: nothing Telegram-specific can be claimed about it.
    return "external";
  }
  if (parsed.protocol === "tg:") return "telegram";
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "external";
  // `hostname` is already normalised and, unlike a prefix regex, cannot be
  // spoofed by `https://t.me.evil.example/`.
  if (parsed.hostname !== "t.me") return "external";
  return TELEGRAM_INVOICE_PATH.test(parsed.pathname) ? "invoice" : "telegram";
}

/** Calls a bridge method if the client actually ships it. */
function callBridge(
  method: ((url: string) => void) | undefined,
  tg: TelegramWebApp,
  url: string,
): boolean {
  if (typeof method !== "function") return false;
  try {
    method.call(tg, url);
    return true;
  } catch {
    // The bridge throws on a URL it does not accept (`WebAppInvoiceUrlInvalid`,
    // `WebAppTelegramUrlInvalid`). Report the miss so the caller degrades.
    return false;
  }
}

/**
 * Hands `url` to the most specific Telegram bridge that will take it, falling
 * back down the chain. The fallbacks are not defensive padding: `openInvoice`
 * is Bot API 6.1+ and `openTelegramLink` 6.0+, so a buyer on an older client
 * has neither, and losing the sheet is far better than losing the payment.
 */
function openViaTelegram(tg: TelegramWebApp, url: string): boolean {
  const kind = classifyTelegramLink(url);
  if (kind === "invoice" && callBridge(tg.openInvoice, tg, url)) return true;
  if (kind !== "external" && callBridge(tg.openTelegramLink, tg, url)) return true;
  return callBridge(tg.openLink, tg, url);
}

/**
 * Opens an external URL the right way for the current runtime.
 *
 * Inside the Telegram Mini App the standard `window.open` is unreliable
 * (sandboxed webview), so we use the Telegram WebApp bridge — see
 * `classifyTelegramLink` for which call each kind of URL needs.
 * Outside Telegram we fall back to a normal new-tab `window.open`, which is
 * safe here because every caller of this function is a click handler: the
 * gesture is live, so the pop-up is not blocked.
 *
 * Used by the "Connect" action so tapping it deep-links into the user's VPN
 * client / subscription page instead of merely copying the URL, and by the
 * "Open payment" button on `/payment-return`, which is the gesture-carrying
 * way through checkout whenever `startCheckoutRedirect` declines.
 */
export function openExternalUrl(url: string): void {
  if (!url) return;
  const tg = window.Telegram?.WebApp;
  if (tg) {
    openViaTelegram(tg, url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Sends the buyer to the payment gateway.
 *
 * Deliberately NOT `openExternalUrl`. That opens a new tab, and a new tab is a
 * pop-up: browsers and in-app webviews only allow one while a user gesture is
 * still on the stack. The checkout link arrives from an async request — by then
 * the gesture is long gone (the purchase flow even fires checkout from an
 * effect on mount, so there is no gesture at all), and the open is silently
 * swallowed. That is the lost-payments bug: the link was fine, nothing opened.
 *
 * Same-tab navigation has no such restriction — it needs no gesture and cannot
 * be pop-up blocked. Leaving the SPA is correct here anyway: the gateway sends
 * the buyer back to `/payment-return` when it is done.
 *
 * Two cases are exceptions, and both end the same way — decline, and let the
 * buyer's press on `/payment-return` be the gesture:
 *
 *   1. Telegram. Inside a Mini App the webview must not be navigated away to a
 *      third-party origin — that breaks the Mini App container — so the
 *      sanctioned route is the WebApp bridge, which itself requires a live
 *      gesture. Nothing here can conjure one, so we do not pretend.
 *   2. A `t.me` checkout URL in a plain browser. Telegram Stars and CryptoPay
 *      both return one, and the "the gateway sends the buyer back" premise
 *      above does not hold for it: t.me takes no `return_url` and will never
 *      return to `/payment-return`. Assigning it would replace the cabinet tab
 *      with a dead end and stop the status poll.
 *
 * @returns `true` when navigation was initiated, `false` when the caller must
 *          fall back to a manual, gesture-carrying button.
 */
export function startCheckoutRedirect(url: string): boolean {
  if (!url) return false;

  // Validate before handing anything to the browser. `location.assign` runs a
  // `javascript:` URL as script in OUR origin, with the session cookie — a sink
  // the previous `window.open(url, "_blank")` never opened. The address comes
  // from an API response, so it is not ours to trust unexamined.
  //
  // This stays a single-value equality test, never a denylist or a set: an
  // allowlist of exactly one scheme is what makes `javascript:` and `data:`
  // unreachable no matter what a gateway returns. `tg:` is deliberately NOT
  // admitted — no gateway we integrate returns one (Stars and CryptoPay both
  // return `https://t.me/…`), and widening the test for a case that does not
  // exist is how the one property this guard has gets traded away.
  // `openExternalUrl` does accept `tg:`, because "Connect" genuinely
  // deep-links into VPN clients; checkout has no such need.
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "https:") return false;

  // The SURFACE question, asked through the shared detector rather than a
  // private one. This used to be a local `isTelegramLaunch()` here that
  // consulted only `window.Telegram` and the loader's flag;
  // `isTelegramMiniAppSurface()` checks the launch parameters FIRST and keeps
  // both of those as fallbacks, so it is a strict superset: it can only move a
  // document from "browser" to "Mini App", never the other way.
  //
  // That direction is the safe one, and it is the whole point. Read a Mini App
  // as a browser and the last line of this function navigates the container
  // away to a gateway origin, killing the Mini App with no way back. Read a
  // browser as a Mini App and the buyer gets the manual "Open payment" button
  // one step early. The rationale for the carriers it consults lives with the
  // detector in `telegram-launch-params.ts`; do not re-derive it here.
  //
  // Note this asks about the SURFACE, not the bridge. The bridge is consulted
  // separately below and is optional: a Mini App on a network that cannot
  // reach telegram.org still must not be navigated away, even though
  // `window.Telegram` will never appear on it.
  if (isTelegramMiniAppSurface()) {
    // Still ask Telegram to open it. Mobile clients honour these bridges
    // without a fresh gesture and this is the path that used to work for them;
    // Desktop enforces the gesture and will decline. Report `false` either way,
    // so the caller keeps the manual button that carries a real gesture — the
    // two are belt and braces, not alternatives.
    //
    // Which bridge matters. Telegram Stars checkout URLs are invoice links, and
    // `openLink` shows the t.me landing page in the in-app browser instead of
    // the payment sheet — the buyer cannot pay from there and has to back out
    // to `/payment-return`. `openViaTelegram` picks the call Telegram accepts.
    const tg = window.Telegram?.WebApp;
    if (tg) openViaTelegram(tg, target.href);
    return false;
  }

  // A `t.me` link is not a gateway checkout page: it carries no `return_url`,
  // so it never sends the buyer back to `/payment-return`, and on desktop it is
  // just an "Open in Telegram" interstitial. Assigning it would replace the
  // cabinet tab — killing the status poll and the pending-checkout view — for a
  // page that cannot complete the purchase and cannot navigate back.
  //
  // So we decline and leave the tab alive. The caller has already stashed the
  // URL and is about to route to `/payment-return`, which renders "Open
  // payment"; that button opens the link in a NEW tab from a real click. That
  // is the only honest answer to the gesture rule — a genuine gesture, not
  // `window.open` from an async callback, which is the pop-up-blocked bug this
  // function was written to fix.
  if (classifyTelegramLink(target.href) !== "external") return false;

  window.location.assign(target.href);
  return true;
}
