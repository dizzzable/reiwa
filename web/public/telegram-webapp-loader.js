/**
 * Load Telegram's Mini App SDK only for a session Telegram actually launched.
 * Regular browser sessions do not need the bridge and may be unable to reach
 * telegram.org, so an unconditional request only creates noisy ERR_FAILED
 * console entries without adding any functionality.
 *
 * Nothing about authentication rides on this script any more. `initData` IS
 * `tgWebAppData` and the cabinet reads it straight off the URL, so a failure
 * here costs the session its native chrome — haptics, BackButton/MainButton,
 * theme, and `openInvoice`, which is the only call that can raise Telegram's
 * payment sheet — and never its sign-in.
 */
(() => {
  // Restated from `web/src/lib/telegram-launch-params.ts`
  // (`TELEGRAM_LAUNCH_PARAMETER_NAMES`) so "the URL says Telegram" and "the
  // loader will request the SDK" stay one rule. Add a name in one place only
  // and the two drift.
  const launchParameterNames = [
    "tgWebAppData",
    "tgWebAppVersion",
    "tgWebAppPlatform",
    "tgWebAppThemeParams",
    "tgWebAppStartParam",
  ];
  const searchParameters = new URLSearchParams(window.location.search);
  const hashParameters = new URLSearchParams(
    window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash,
  );
  const isTelegramMiniApp = launchParameterNames.some(
    (name) => searchParameters.has(name) || hashParameters.has(name),
  );

  /**
   * The launch parameters as the SDK itself persists them
   * (`sessionStorage['__telegram__initParams']`); `lib/telegram-launch-params.ts`
   * writes the same key in the same shape on the launch document.
   *
   * Consulted deliberately. The URL test alone is right only for the document
   * Telegram opened: a second document in the same tab — a reload, the return
   * leg from a payment gateway, an OS-restored webview — has lost the hash, and
   * skipping the SDK there leaves a live Mini App with no BackButton, no theme
   * and no `openInvoice`, which is a payment the user cannot complete. The
   * early return is still worth keeping for the case it was written for,
   * because this key exists only in a tab Telegram launched: a plain browser
   * session on a network that blocks telegram.org still never asks for the
   * script. That is the whole trade — one extra request in a session already
   * known to be a Mini App, in exchange for the bridge those documents need.
   */
  const hasStoredLaunchParameters = () => {
    try {
      const stored = JSON.parse(
        window.sessionStorage.getItem("__telegram__initParams"),
      );
      if (stored === null || typeof stored !== "object") return false;
      return launchParameterNames.some(
        (name) => typeof stored[name] === "string" && stored[name].length > 0,
      );
    } catch (error) {
      // Storage disabled, or somebody else's value under the key. Treat it as
      // "not a Telegram session" — the URL test above is the authority.
      return false;
    }
  };

  if (!isTelegramMiniApp && !hasStoredLaunchParameters()) return;
  if (document.querySelector("script[data-reiwa-telegram-sdk]")) return;

  window.__reiwaTelegramSdkState = "loading";
  const script = document.createElement("script");
  script.dataset.reiwaTelegramSdk = "true";
  script.crossOrigin = "anonymous";
  script.async = true;
  script.src = "https://telegram.org/js/telegram-web-app.js";
  script.addEventListener("load", () => {
    window.__reiwaTelegramSdkState = "ready";
    window.dispatchEvent(new Event("reiwa:telegram-sdk-ready"));
  });
  script.addEventListener("error", () => {
    window.__reiwaTelegramSdkState = "error";
    window.dispatchEvent(new Event("reiwa:telegram-sdk-error"));
  });
  document.head.appendChild(script);
})();
