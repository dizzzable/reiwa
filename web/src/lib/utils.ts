import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// The bare i18next singleton, NOT `@/i18n/i18n`. Importing the app's
// bootstrap here drags `initReactI18next` into every module that touches
// `cn()` — which is all of them — and thirty test files that mock
// `react-i18next` stopped loading at once. This is the same instance the
// bootstrap configures, just without its side effects.
import i18n from "i18next";
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
 * A compact numeric date for the subscription card, where space is tight.
 *
 * It used to hand-build `DD.MM.YY`, which is the Russian order and only the
 * Russian order — so an English customer read their expiry date as `15.05.26`
 * and had no way to know whether that was May or the 15th month. The card is
 * the first screen anyone opens, and the expiry date is the one number on it
 * that matters.
 *
 * `2-digit` on all three parts keeps the width the layout was built around.
 *
 * `timeZone`: the calendar the date is read on — the operator's «Часовой
 * пояс» for a subscription date (`lib/operator-time-zone.ts`), so the card
 * says the day the bot's notices say; the phone's own when omitted.
 */
export function formatDate(value: string | number | Date | null | undefined, timeZone?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(getActiveLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/**
 * Formats an ISO date-time string as a localised short date + time
 * (e.g. "23 окт, 14:30"), on `timeZone`'s clock — the phone's own when
 * omitted. A time on the operator's clock is printed with its zone named
 * («(по Москве)», `zonePhrase`), which is the caller's to add.
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  timeZone?: string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(getActiveLocale(), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
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

/**
 * The BCP-47 tag every date in this app should be formatted with.
 *
 * It used to read `document.documentElement.lang` — a value nothing in the
 * app has ever written. `index.html` ships `lang="ru"`, so the fallback was
 * unreachable and this function returned Russian for everybody, on every
 * screen that shows a date: Activity, Transactions, promo history, add-ons,
 * the notification feed and the notification detail. An English customer read
 * «23 окт, 14:30».
 *
 * `i18n.language` is the value the language switch actually changes, and it is
 * what the rest of the app already consults — `points-history-list` reads it
 * directly for exactly this reason.
 */
export function getActiveLocale(): string {
  return i18n.language?.startsWith("ru") === false ? "en-US" : "ru-RU";
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
 * The origins Telegram serves its own web shells from — the only parents a
 * framed Mini App's event is ever addressed to:
 *   - `https://web.telegram.org` — Telegram Web K and Web A under `/k/` and
 *     `/a/`, and the page Telegram Desktop for Linux loads a Mini App's frame
 *     into (`kShellOriginCheck` in `attach_bot_webview_linux_shell.cpp`);
 *   - `https://webk.telegram.org` — Web K on its own host, one of the two
 *     domains its build config lists (`web.telegram.org`, `webk.telegram.org`);
 *   - `https://weba.telegram.org` — Web A on its own host, where its
 *     `redirect.js` keeps a signed-in user (it sends a visitor on to
 *     `web.telegram.org/a` only when `localStorage` holds no `tt-global-state`).
 *     `webz.telegram.org` answers with a redirect to it.
 *
 * Exactly these three. The cabinet's CSP lets any `https://*.telegram.org` page
 * frame it (`src/api/app.ts`), but a telegram.org host that is not one of these
 * is not a Mini App's client, and is not handed a signed link.
 */
const TELEGRAM_WEB_ORIGINS: readonly string[] = [
  "https://web.telegram.org",
  "https://webk.telegram.org",
  "https://weba.telegram.org",
];

/**
 * Posts one event to the Telegram client the way `telegram-web-app.js` does,
 * for a document the SDK never reached.
 *
 * The SDK is ~100 KB from telegram.org, the host this product's customers
 * cannot reach — but the channel it writes to belongs to the client, not to
 * the SDK:
 *   - Telegram Desktop on Windows and macOS, Telegram for Android and Telegram
 *     for iOS inject `window.TelegramWebviewProxy` into the Mini App, and the
 *     SDK sends `postEvent(eventType, JSON.stringify(eventData))` through it;
 *   - Telegram Web and Telegram Desktop for Linux run the Mini App in a frame,
 *     and read `JSON.stringify({ eventType, eventData })` from `postMessage`.
 *
 * The frame message is addressed to a Telegram shell's origin
 * (`TELEGRAM_WEB_ORIGINS`) where the SDK says `*`: what goes through here
 * carries a signed subscription link. A named target has a cost `*` does not. A
 * browser DROPS a message whose target origin is not the parent's — no
 * exception, no event — so from here a post nobody received looks exactly like
 * one that arrived. Addressed to `https://web.telegram.org` alone, the event
 * went nowhere in Web K on `webk.telegram.org` and Web A on `weba.telegram.org`,
 * this still returned `true`, and `openExternalUrl` skipped the `window.open`
 * that would have opened the link. So the parent is asked about first:
 *   - where the engine names it — `location.ancestorOrigins`, whose first entry
 *     is the parent's origin, in Chromium, WebKit (WebKitGTK included) and
 *     Firefox 148+ — the event goes to that origin if it is a Telegram shell's,
 *     and any other parent is `false`, so the caller opens the link itself;
 *   - where it cannot — an engine without `ancestorOrigins`, such as Firefox
 *     before 148, or a parent that hides its origin — the event goes once to
 *     each Telegram shell's origin. The parent has one origin, so the browser
 *     delivers one copy at most, and none to a parent that is not a Telegram
 *     shell. That is `true`: there a frame of any other origin gets nothing
 *     opened, the price of not knowing who the parent is.
 *
 * A parent that hides its origin is one the engine cannot name, not a stranger.
 * Since whatwg/html#11560 a document framed by an iframe with
 * `referrerpolicy="no-referrer"` reads that parent in `ancestorOrigins` as
 * `"null"`, and Telegram Desktop for Linux frames the Mini App exactly so (its
 * shell's `page.js`: `referrerPolicy = 'no-referrer'`). WebKitGTK does not mask
 * yet (WebKit bug 303537); once it does, that client keeps this channel instead
 * of dropping to a `window.open` nobody has checked in its shell. Nothing is
 * handed to a stranger for it, and not because of who may frame the cabinet —
 * the API's CSP admits `*.telegram.org` and `*.t.me`, and the nginx deployment
 * sends no CSP at all: every post names its target, and the masking hides the
 * origin from this document, not from the browser, which still delivers only to
 * a parent whose real origin is that target. Neither Telegram Web client sets a
 * referrer policy on the Mini App's frame.
 *
 * `true` means the event was handed to a channel, not that the client acted on
 * it: neither channel answers. Only for a Mini App — the caller decides that.
 */
export function postTelegramEvent(eventType: string, eventData: Record<string, unknown>): boolean {
  const proxy = window.TelegramWebviewProxy;
  if (proxy !== undefined) {
    try {
      proxy.postEvent(eventType, JSON.stringify(eventData));
      return true;
    } catch {
      return false;
    }
  }
  try {
    if (window.parent === window) return false;
    const message = JSON.stringify({ eventType, eventData });
    // lib.dom types it as always there; Firefox before 148 does not have it.
    const ancestorOrigins: DOMStringList | undefined = window.location.ancestorOrigins;
    const parentOrigin = ancestorOrigins?.[0];
    // No `ancestorOrigins`, or a parent masked by `referrerpolicy="no-referrer"`.
    if (parentOrigin === undefined || parentOrigin === "null") {
      for (const origin of TELEGRAM_WEB_ORIGINS) window.parent.postMessage(message, origin);
      return true;
    }
    const shellOrigin = TELEGRAM_WEB_ORIGINS.find((origin) => origin === parentOrigin);
    if (shellOrigin === undefined) return false;
    window.parent.postMessage(message, shellOrigin);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `hostname` is one Telegram resolves as its own link rather than as a
 * web page: `t.me`, `telegram.me` and `telegram.dog`, each also under `www.`,
 * and a `<name>.t.me` subdomain. That is every form Telegram Desktop's
 * `TryConvertUrlToLocal` (`core/local_url_handlers.cpp`) turns into a `tg://`
 * link — `(www\.)?(telegram\.(me|dog)|t\.me)/…` and `<name>\.t\.me`, both
 * case-insensitive, both on http as well. A `t.me` subdomain it does not
 * convert (a one-character name, a deeper subdomain) is held back too, and
 * keeps the `window.open` all of these had before.
 *
 * Not the rule `classifyTelegramLink` applies, on purpose: that one picks an
 * SDK bridge, and the SDK's `openTelegramLink` and `openInvoice` refuse every
 * host here but `t.me` and `telegram.me` (`isTmeHostname`). With the SDK these
 * links keep going where they always went.
 */
function isTelegramLinkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "t.me" ||
    host.endsWith(".t.me") ||
    host === "telegram.me" ||
    host === "www.telegram.me" ||
    host === "telegram.dog" ||
    host === "www.telegram.dog"
  );
}

/**
 * The address a `web_app_open_link` event may carry, as `openLink` would send
 * it (normalised, like the SDK's `a.href`), or `null` for anything else.
 *
 * http and https only, and never a link to a Telegram host
 * (`isTelegramLinkHost`) — see `openExternalUrl`.
 */
function openLinkEventUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return isTelegramLinkHost(parsed.hostname) ? null : parsed.href;
}

/**
 * Opens an external URL the right way for the current runtime.
 *
 * Three ways out, in this order, and every one of them inside the click that
 * called this — a browser blocks a pop-up once the gesture is gone, and the
 * mobile Telegram clients refuse an open long after the last touch, so nothing
 * may be awaited first:
 *
 *   1. The SDK, when it arrived: `openViaTelegram` hands the URL to the bridge
 *      call its kind needs (`classifyTelegramLink`). Its answer is USED — a
 *      bridge that threw used to end the tap with nothing opened at all.
 *   2. Inside a Mini App the SDK never reached, or whose bridge refused: the
 *      client's own channel, `postTelegramEvent('web_app_open_link')` — the
 *      event `openLink` sends. Telegram Desktop needs no gesture for it and
 *      opens the system browser on all three systems (`allowOpenLink()` returns
 *      true; `File::OpenUrl` → `QDesktopServices::openUrl`).
 *   3. `window.open` in a new tab. Outside Telegram this is the whole story, and
 *      safe because every caller is a click handler: the gesture is live, so
 *      the pop-up is not blocked.
 *
 * ── What step 2 never carries ────────────────────────────────────────────────
 *
 * A scheme other than http and https. The SDK throws `WebAppTgUrlInvalid` for
 * one before the client sees it, and a client that did see one would do worse
 * than refuse: Telegram Desktop checks the event against
 * `web_app_allowed_protocols` and CLOSES THE MINI APP on a miss
 * (`Panel::openExternalLink` → `requestClose()`). An app scheme or `tg:` goes to
 * `window.open`, which is what it got before this step existed.
 *
 * A link to a Telegram host — `t.me`, `telegram.me`, `telegram.dog`, their
 * `www.` forms, `<name>.t.me` (`isTelegramLinkHost`). With the SDK a `t.me` link
 * goes to `openInvoice` or `openTelegramLink` — the payment sheet and a native
 * resolve — and the other forms to `openLink`, as they always did. Without the
 * SDK this does not rebuild those events by hand, and does not send the link to
 * `web_app_open_link` either: Telegram Desktop hands that event straight to the
 * system browser (`Panel::openExternalLink` → `File::OpenUrl`), a landing page
 * where a Stars invoice cannot be paid, while a `window.open` passes through its
 * navigation handler, which resolves every one of those hosts inside the client
 * (`botHandleLocalUri` → `TryConvertUrlToLocal`). Holding back `t.me` alone sent
 * `telegram.me/$<slug>` to that browser. It keeps `window.open`, exactly what it
 * had before — read from Telegram Desktop's source, not seen on a device, and
 * not checked at all for the mobile clients. Not a good path either, only the
 * old one: Telegram Desktop resolves such a link by CLOSING the Mini App first
 * (`botHandleLocalUri` → `botClose()`), which ends a `/payment-return` poll. The
 * events that keep it open are `web_app_open_invoice` and `web_app_open_tg_link`,
 * which this path does not build by hand.
 *
 * A document that is not a Mini App — `isTelegramMiniAppSurface()`, the
 * detector checkout uses. A proxy or a parent frame there is not a Mini App's
 * client, and is not handed the link.
 *
 * Used by the "Connect" action so tapping it deep-links into the user's VPN
 * client / subscription page instead of merely copying the URL, by the connect
 * screen's trampoline button (`deep-link-handoff.ts`), and by the "Open
 * payment" button on `/payment-return`, which is the gesture-carrying way
 * through checkout whenever `startCheckoutRedirect` declines.
 */
export function openExternalUrl(url: string): void {
  if (!url) return;
  const tg = window.Telegram?.WebApp;
  if (tg !== undefined && openViaTelegram(tg, url)) return;
  const link = openLinkEventUrl(url);
  const insideMiniApp = isTelegramMiniAppSurface();
  if (link !== null && insideMiniApp && postTelegramEvent("web_app_open_link", { url: link })) {
    return;
  }
  // A link the SDK's bridge REFUSED — an app scheme, a `tg:` or `t.me` link an
  // old client has no call for — ends here inside a Mini App, as it always did
  // with the SDK loaded. `window.open` is not a softer retry for it: Telegram
  // for Android hands a new window to a web view of its own, and a scheme that
  // view cannot load becomes an error page there — the class of defect
  // `deep-link-handoff.ts` describes for the anchor — so "nothing happened" is
  // the lesser failure. Without the SDK nothing refused the link, and it keeps
  // the new tab it had before.
  if (tg !== undefined && link === null && insideMiniApp) return;
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
    // without a fresh gesture and this is the path that used to work for them.
    // Telegram Desktop checks no gesture for them either: in 7.2.8
    // `allowOpenLink()` returns true, and the invoice and t.me handlers check
    // nothing. What Desktop does refuse without one is `window.open` — on
    // Windows lib_webview opens a new-window request only when WebView2 reports
    // it `IsUserInitiated`. Report `false` either way: nothing acknowledges that
    // the page opened, and without the SDK nothing was asked at all, so the
    // caller keeps the manual button that carries a real gesture — the two are
    // belt and braces, not alternatives.
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
