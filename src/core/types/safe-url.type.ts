/**
 * Branded types for URLs that have passed Telegram's button-URL
 * validation. The brand is purely a TypeScript-level marker — at runtime
 * these are plain `string`s. The point is to force callers to build
 * inline-keyboard buttons through `isTelegramSafeButtonUrl(...)` instead
 * of dropping arbitrary strings into `kb.url(...)`.
 */
declare const TelegramSafeUrlBrand: unique symbol;
export type TelegramSafeUrl = string & { readonly [TelegramSafeUrlBrand]: never };

/**
 * Returns `true` when the URL passes Telegram's edge validation for
 * inline-keyboard URL and webApp buttons:
 *   - protocol must be `https://` (Telegram rejects `http://` for both)
 *   - host must NOT be `localhost` or `127.0.0.1` (rejected even for
 *     `https://`, see "Wrong HTTP URL" error)
 *
 * In production reiwa runs behind a real https domain so the guard is
 * a no-op. In local dev (`REIWA_DOMAIN=localhost:5173` -> resolves to
 * `http://localhost:5173`) buttons silently disappear instead of
 * crashing the entire reply with `400 Bad Request`.
 */
export function isTelegramSafeButtonUrl(url: string | null | undefined): url is TelegramSafeUrl {
  if (!url) return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('://localhost') || lower.includes('://127.0.0.1')) return false;
  return true;
}
