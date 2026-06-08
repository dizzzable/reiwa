/**
 * Builds the URL the payment provider should redirect the customer to after
 * completing (or cancelling) a payment, based on the originating request context.
 *
 * Two contexts are supported:
 *
 *  - **`tma`** — Request originated from a Telegram Mini App (validated initData).
 *    The redirect must take the user back to Telegram. We build a bot deep link
 *    of the form `https://t.me/<BOT_USERNAME>?start=payment_return`. Telegram
 *    opens the bot chat, and the Mini App is re-opened from the chat's menu
 *    button (or the inline button the bot's `/start` handler may render).
 *
 *    The Mini App short name itself stays in BotFather — we deliberately do
 *    NOT require it here, because the `?start=...` form is universal across
 *    every Mini App variant (menu-button Web App, named Web App, attached
 *    Web App) and avoids duplicating BotFather configuration in env vars.
 *
 *  - **`web`** — Request originated from a regular web browser. The redirect
 *    targets the public web origin we expose, e.g.
 *    `https://reiwa.example/payment-return`. The SPA fetches the latest
 *    payment status for the authenticated user upon arrival.
 *
 * If no destination can be built for the given context (e.g. neither
 * `BOT_USERNAME` nor `REIWA_DOMAIN` is configured), the function
 * returns `null`, signalling to callers that the upstream service should
 * fall back to its own default (the generic `${REZEIS_DOMAIN}/payments/result`).
 */

import type { ReiwaConfig } from "../config.js";
import { resolveReiwaPublicUrl } from "../config.js";
import type { RequestContext } from "../api/middleware/context-detection.js";

/** Stable token forwarded to `/start` so the bot can route the user back. */
const TMA_START_PARAM = "payment_return";

export interface BuildPaymentReturnUrlInput {
  readonly context: RequestContext;
  readonly config: ReiwaConfig;
  /**
   * Caller-supplied override (e.g. a value from the SPA). When present and
   * non-empty it wins over the computed value. The upstream DTO validates that
   * the value is a well-formed URL.
   */
  readonly override?: string | null;
}

export function buildPaymentReturnUrl(input: BuildPaymentReturnUrlInput): string | null {
  const trimmedOverride = input.override?.trim();
  if (trimmedOverride && trimmedOverride.length > 0) {
    return trimmedOverride;
  }

  if (input.context === "tma") {
    return buildTelegramReturnUrl(input.config) ?? buildWebReturnUrl(input.config);
  }

  return buildWebReturnUrl(input.config);
}

/**
 * Resolves the effective purchase context used to build the return URL.
 *
 * Why an explicit client hint is needed: the SPA does NOT attach
 * `x-telegram-init-data` to regular API calls, so the server-derived
 * `req.context` (set by the context-detection middleware from that header)
 * always resolves to `"web"` for Mini-App-originated checkouts. Sending the
 * header on every request is not an option either — `initData` expires after
 * one hour, after which the middleware would reject it with `403`, breaking
 * a long-lived Mini App session.
 *
 * Instead the Mini App sends an explicit `source` field on the checkout body.
 * It only influences the redirect destination (never authorization), which is
 * consistent with the already client-trusted `successUrl` / `failUrl`
 * overrides. Precedence: explicit client `source` → detected context → `web`.
 */
export function resolvePurchaseContext(
  detected: RequestContext | undefined,
  clientSource: unknown,
): RequestContext {
  if (clientSource === "tma" || clientSource === "web") {
    return clientSource;
  }
  return detected ?? "web";
}

function buildTelegramReturnUrl(config: ReiwaConfig): string | null {
  const botUsername = config.BOT_USERNAME;
  if (!botUsername) {
    return null;
  }
  return `https://t.me/${botUsername}?start=${TMA_START_PARAM}`;
}

function buildWebReturnUrl(config: ReiwaConfig): string | null {
  const baseUrl = resolveReiwaPublicUrl(config);
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/payment-return`;
}
