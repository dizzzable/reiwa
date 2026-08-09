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
 * A non-empty launch `initData` is the signal, and it is read off the LAUNCH,
 * not out of the bridge. `initData` IS `tgWebAppData`: Telegram writes it into
 * the launch document's URL from the first byte, and
 * `readTelegramLaunchInitData()` also restores it from the in-memory capture and
 * the SDK's session mirror — which this call needs, because checkout happens
 * several react-router navigations away from the launch document and each one
 * drops the fragment.
 *
 * The bridge cannot be the source, and this is the expensive place to get it
 * wrong. `window.Telegram` exists only after ~100 KB has been fetched from
 * `telegram.org/js/telegram-web-app.js`, and this product sells VPN: the
 * customer at the checkout does not have one yet, so telegram.org is precisely
 * the host their network blocks. Reading the bridge here classified every one of
 * those Mini App buyers as `"web"`, and the server gives this hint top
 * precedence (`resolvePurchaseContext`) — its own `detected` fallback is always
 * `"web"`, because nothing client-side sends `x-telegram-init-data`. So
 * `buildPaymentReturnUrl` produced `${REIWA_DOMAIN}/payment-return` instead of
 * the `t.me` deep link, and the gateway dropped a customer who had just paid
 * INSIDE the Mini App onto the website in an external browser — a different
 * origin, no session, and no sign of the purchase they had just made.
 *
 * The comment this replaces claimed to be "the same check `ContextRouter` and
 * the gateway picker already rely on". That stopped being true at `c087865`:
 * `context-router.tsx` calls `detectTelegramInitData(0)`, which reads the URL.
 * The claim is a large part of why this read survived three sweeps — it named a
 * precedent that had already been removed.
 *
 * This hint is sent in the checkout request body (not as the
 * `x-telegram-init-data` header) on purpose: initData expires after one hour,
 * and the API would reject a stale header with 403, breaking a long-lived Mini
 * App session. The hint only influences the redirect destination, never auth.
 */
import { readTelegramLaunchInitData } from "@/lib/telegram-launch-params";

export type ClientSource = "tma" | "web";

export function getClientSource(): ClientSource {
  if (typeof window === "undefined") return "web";
  if (readTelegramLaunchInitData() !== null) return "tma";
  // The bridge is the fallback, for a launch shape the URL never carried — an
  // embedder that hands the payload straight to `window.Telegram`.
  const initData = window.Telegram?.WebApp?.initData;
  return typeof initData === "string" && initData.length > 0 ? "tma" : "web";
}
