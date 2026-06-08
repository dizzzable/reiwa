/**
 * client-source
 * ─────────────
 * Detects which surface the SPA runs in so the backend can build a
 * post-payment redirect back to the right place:
 *   - "tma" → Telegram Mini App → redirect back to Telegram.
 *   - "web" → a regular browser tab → redirect back to the web app.
 *
 * Telegram injects a non-empty `WebApp.initData` only inside a Mini App, so
 * its presence is the canonical signal. Sent in the checkout body (not as a
 * header) because initData expires after one hour and a stale header would
 * 403 a long-lived Mini App session; this hint only affects the redirect.
 */
export type ClientSource = "tma" | "web";

export function getClientSource(): ClientSource {
  const initData =
    typeof window !== "undefined" ? window.Telegram?.WebApp?.initData : undefined;
  return initData && initData.length > 0 ? "tma" : "web";
}
