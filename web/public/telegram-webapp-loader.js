/**
 * Load Telegram's Mini App SDK only when Telegram launch parameters are
 * present. Regular browser sessions do not need the bridge and may be unable
 * to reach telegram.org, so an unconditional request only creates noisy
 * ERR_FAILED console entries without adding any functionality.
 */
(() => {
  const launchParameterNames = [
    "tgWebAppData",
    "tgWebAppVersion",
    "tgWebAppPlatform",
    "tgWebAppThemeParams",
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

  if (!isTelegramMiniApp) return;
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
