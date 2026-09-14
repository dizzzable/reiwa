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
 * button, with the app installed, did different things in different hosts.
 *
 * ── Inside a Telegram Mini App the anchor is the defect, on every client ─────
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
 * Telegram DESKTOP refuses it before Telegram's own code is asked, on Windows,
 * macOS and Linux alike. Its web view is `desktop-app/lib_webview`, and
 * `Window::navigationStartHandler()` wraps the client's handler in a scheme
 * allowlist (`webview/webview_embed.cpp:421-429`): a URL that does not start
 * with `http://`, `https://`, `tonsite://` or `ton://` is refused outright. On
 * Windows the refusal cancels WebView2's `NavigationStarting` (`put_Cancel(TRUE)`,
 * `webview_windows_edge_chromium.cpp:548-562`), on macOS it answers WKWebView
 * with `WKNavigationActionPolicyCancel`, on Linux it ignores the WebKitGTK
 * navigation — and on none of them does the scheme reach the system. The
 * filter has been in lib_webview since 2022.
 *
 * Version 0.9.7.42 still rendered the anchor for Telegram Desktop on Windows,
 * on the premise that an app had been seen opening from this screen there. The
 * source rules that out, and so did the owner: on 0.9.7.42 «Добавить подписку»
 * in Telegram Desktop on Windows did nothing. There is no Telegram client left
 * for which this file keeps the anchor.
 *
 * `Telegram.WebApp.openLink` is the documented way out of a Mini App and it
 * takes http and https only: the SDK throws `WebAppTgUrlInvalid` for anything
 * else before the client sees the call, and both mobile clients refuse such a
 * scheme again unless the server lists it in `web_app_allowed_protocols`.
 * Telegram Desktop checks that same list and CLOSES the Mini App on a miss.
 *
 * So inside Telegram the button never carries the app's scheme — on every
 * client, including ones this file has never heard of. It asks `openLink` to
 * open the trampoline page on the cabinet's own origin (`connect-trampoline.ts`),
 * which lands in a real browser — Safari from iOS; Telegram's in-app browser, a
 * Custom Tab or the default browser from Android; a new tab from the web
 * clients; the system's default browser from Telegram Desktop, which asks for no
 * gesture (`allowOpenLink()` returns true) and ends in
 * `QDesktopServices::openUrl` on all three systems. Safari passes an app scheme
 * on from a tap (the owner's own control), Telegram's in-app browser does it in
 * the same `shouldOverrideUrlLoading` that refuses the Mini App, and Chrome does
 * it for a navigation that began with a gesture — which is why that page opens
 * nothing until its own button is tapped.
 *
 * The hop does not need the SDK. `openLink` is one event, `web_app_open_link`,
 * written to a channel the client provides — `window.TelegramWebviewProxy`, or
 * the parent frame's `postMessage` where the Mini App is a frame (Telegram Web,
 * Telegram Desktop for Linux) — and `openExternalUrl` writes it there itself
 * when `window.Telegram` never arrived from telegram.org, which on this
 * product's networks is common.
 *
 * ── Outside Telegram nothing changes ────────────────────────────────────────
 *
 * Safari, Chrome and an installed web app hand an app scheme to the system from
 * a same-window tap, and that anchor is what the owner saw working.
 *
 * "Inside Telegram" is `isTelegramMiniAppSurface()` — the launch parameters
 * first, the bridge and the loader's flag only as fallbacks, so it can only
 * move a document towards the safe answer — and it is the only input. Neither
 * the platform nor the user agent is consulted: no value of either can earn a
 * Mini App the anchor. The two ways to be wrong are not equal: a browser read
 * as a Mini App loses one tap to a browser page, and a Mini App read as a
 * browser gets an anchor that does nothing on Telegram Desktop and iOS and
 * destroys the whole Mini App on Android.
 */

export type DeepLinkHandoff = 'anchor' | 'trampoline';

export interface DeepLinkHost {
  /** `isTelegramMiniAppSurface()`. */
  readonly insideTelegram: boolean;
}

export function deepLinkHandoff(host: DeepLinkHost): DeepLinkHandoff {
  return host.insideTelegram ? 'trampoline' : 'anchor';
}
