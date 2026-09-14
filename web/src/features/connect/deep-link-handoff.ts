/**
 * deep-link-handoff
 * ─────────────────
 * How an "add to app" button hands its link over, in the host the cabinet is
 * running in: as a plain anchor, or through the trampoline page.
 *
 * Nothing on a web page opens an app. A `happ://` or `incy://` link leaves the
 * page only because whatever renders the page meets a scheme it cannot load and
 * passes it on — so whether the button works is decided by the HOST, not by the
 * link, and not by the app. The owner's recordings say exactly that: the same
 * button, with the app installed, did three different things.
 *
 * ── Inside a Telegram Mini App the anchor is the defect ─────────────────────
 *
 * Telegram for ANDROID loads it. `BotWebViewContainer`'s `shouldOverrideUrlLoading`
 * passes an unknown scheme to the system only for a web view that is NOT a bot's
 * (`if (!bot)`); a Mini App's falls through to `return false`, WebView loads
 * `incy://…` itself, fails with `net::ERR_UNKNOWN_URL_SCHEME`, and
 * `onReceivedError` replaces the whole Mini App with Telegram's error page —
 * «Не удалось загрузить 2GET SHOP» and a reload button. Recorded by the owner.
 *
 * Telegram for iOS lets it load and nothing happens. `WebAppController`'s
 * `decidePolicyFor navigationAction` cancels only `t.me` and `telegra.ph`
 * links, and WebKit on iOS hands an allowed navigation to the system only when
 * it is a universal link — an app scheme simply fails to load. The owner saw
 * the button do nothing in the Mini App and work in Safari on the same phone.
 *
 * `Telegram.WebApp.openLink` is the documented way out of a Mini App and it
 * takes http and https only: the SDK throws `WebAppTgUrlInvalid` for anything
 * else before the client sees the call, and both mobile clients refuse such a
 * scheme again unless the server lists it in `web_app_allowed_protocols`.
 *
 * So inside Telegram the button never carries the app's scheme. It asks
 * `openLink` to open the trampoline page on the cabinet's own origin
 * (`connect-trampoline.ts`), which lands in a real browser — Safari from iOS;
 * Telegram's in-app browser, a Custom Tab or the default browser from Android;
 * a new tab from the web clients. Safari passes an app scheme on from a tap
 * (the owner's own control), Telegram's in-app browser does it in the same
 * `shouldOverrideUrlLoading` that refuses the Mini App, and Chrome does it for a
 * navigation that began with a gesture — which is why that page opens nothing
 * until its own button is tapped.
 *
 * ── The one Telegram host that keeps the anchor ─────────────────────────────
 *
 * Telegram Desktop on Windows: the owner opened an app from this screen there,
 * live, with the plain anchor. Telegram Desktop's web view allows the
 * navigation and leaves it to the engine (`setNavigationStartHandler` in
 * `attach_bot_webview.cpp`), and on Windows that engine is WebView2, which
 * deals with an external protocol itself. Taking a working desktop flow through
 * a browser tab would be a regression nobody asked for.
 *
 * The same client on macOS and Linux takes the trampoline. There the engine is
 * WebKit — WKWebView on macOS, WebKitGTK on Linux — Telegram Desktop answers
 * the navigation "allow", and nothing in it passes the scheme to the system.
 * WKWebView does that on its own only for an embedder that leaves the decision
 * to it, so the load simply fails with nothing on screen: the iOS path above,
 * where the owner watched the button do nothing. On Linux the Mini App is a
 * frame inside Telegram's own shell page, and WebKitGTK drops a failed frame
 * navigation without a word. Neither is recorded on a device; the hop is safe
 * on both, because Telegram Desktop's `openLink` opens the system browser
 * (`File::OpenUrl`).
 *
 * `tdesktop` is ONE launch parameter for all three systems, so the web view's
 * user agent is what tells them apart — `Windows NT` in WebView2's. It is read
 * for that and nothing else: beside the launch parameter it can only take the
 * anchor away, and it never decides whether the document is inside Telegram.
 * A user agent this file does not recognise costs a Telegram Desktop user one
 * tap to a browser page.
 *
 * Every OTHER value of `tgWebAppPlatform` takes the trampoline, including ones
 * this file has never heard of. The two ways to be wrong are not equal: a host
 * that could have opened the anchor loses one tap to a browser page, and a host
 * that could not loses the whole Mini App.
 *
 * ── Outside Telegram nothing changes ────────────────────────────────────────
 *
 * Safari, Chrome and an installed web app hand an app scheme to the system from
 * a same-window tap, and that anchor is what the owner saw working.
 *
 * "Inside Telegram" is `isTelegramMiniAppSurface()` — the launch parameters
 * first, the bridge and the loader's flag only as fallbacks, so it can only
 * move a document towards the safe answer. The platform is
 * `readTelegramLaunchPlatform()`, launch parameters only: the bridge's
 * `platform` is `unknown` until the SDK arrives from telegram.org, which on
 * this product's networks may be never.
 */

export type DeepLinkHandoff = 'anchor' | 'trampoline';

export interface DeepLinkHost {
  /** `isTelegramMiniAppSurface()`. */
  readonly insideTelegram: boolean;
  /** `readTelegramLaunchPlatform()` — from the launch parameters, never the bridge. */
  readonly telegramPlatform: string | null;
  /**
   * `navigator.userAgent`. Consulted only inside Telegram, and only to narrow
   * the Telegram Desktop exception to Windows.
   */
  readonly userAgent: string;
}

/**
 * Telegram clients whose Mini App web view has been seen opening an app from a
 * same-window anchor on this screen, each with the user agent of the one system
 * it was seen on. One entry, and it needs a device to add another.
 */
const ANCHOR_VERIFIED_TELEGRAM_HOSTS: ReadonlyMap<string, RegExp> = new Map([['tdesktop', /\bWindows NT\b/]]);

export function deepLinkHandoff(host: DeepLinkHost): DeepLinkHandoff {
  if (!host.insideTelegram) return 'anchor';
  const seenOn = host.telegramPlatform === null ? undefined : ANCHOR_VERIFIED_TELEGRAM_HOSTS.get(host.telegramPlatform);
  return seenOn !== undefined && seenOn.test(host.userAgent) ? 'anchor' : 'trampoline';
}
