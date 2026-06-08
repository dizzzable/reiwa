/**
 * client-source
 * ─────────────
 * Detects which surface the SPA is running in so the backend can build a
 * post-payment redirect that returns the user to the right place:
 *
 *   - "tma" → running inside a Telegram Mini App → redirect back to Telegram
 *     (a `t.me/<bot>?start=payment_return` deep link).
 *   - "web" → a regular browser tab → redirect back to the web app
 *     (`${REIWA_DOMAIN}/payment-return`).
 *
 * Telegram injects a non-empty `WebApp.initData` only inside a Mini App, so its
 * presence is the canonical signal — the same check `ContextRouter` and the
 * gateway picker already rely on.
 *
 * This hint is sent in the checkout request body (not as the
 * `x-telegram-init-data` header) on purpose: initData expires after one hour,
 * and the API would reject a stale header with 403, breaking a long-lived Mini
 * App session. The hint only influences the redirect destination, never auth.
 */
export type ClientSource = "tma" | "web";

export function getClientSource(): ClientSource {
  const initData =
    typeof window !== "undefined" ? window.Telegram?.WebApp?.initData : undefined;
  return initData && initData.length > 0 ? "tma" : "web";
}
