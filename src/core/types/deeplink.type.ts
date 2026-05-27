/**
 * Telegram bot deep-link payloads.
 *
 * The `?start=<payload>` URL parameter (or `t.me/<bot>?start=<payload>`)
 * is delivered to the bot as the first argument of the `/start` command.
 * Reiwa treats the payload as a discriminated union: a known prefix
 * (`ref_`, `promo_`, `link_`) routes the user into a specific use-case;
 * everything else is the canonical "open the menu" entry.
 */
export type DeeplinkPayload =
  | { readonly kind: 'menu' }
  | { readonly kind: 'referral'; readonly token: string }
  | { readonly kind: 'promo'; readonly code: string }
  | { readonly kind: 'link'; readonly code: string }
  | { readonly kind: 'paymentReturn' };

const REFERRAL_PREFIX = 'ref_';
const PROMO_PREFIX = 'promo_';
const LINK_PREFIX = 'link_';
const PAYMENT_RETURN = 'payment_return';

/**
 * Parse the raw `/start <payload>` argument into a typed deeplink. Empty
 * or malformed inputs return the canonical `menu` entry — we never
 * surface parse errors to the user; they just see the main menu.
 */
export function parseDeeplink(raw: string | undefined | null): DeeplinkPayload {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { kind: 'menu' };
  if (trimmed === PAYMENT_RETURN) return { kind: 'paymentReturn' };
  if (trimmed.startsWith(REFERRAL_PREFIX)) {
    const token = trimmed.slice(REFERRAL_PREFIX.length);
    return token ? { kind: 'referral', token } : { kind: 'menu' };
  }
  if (trimmed.startsWith(PROMO_PREFIX)) {
    const code = trimmed.slice(PROMO_PREFIX.length);
    return code ? { kind: 'promo', code } : { kind: 'menu' };
  }
  if (trimmed.startsWith(LINK_PREFIX)) {
    const code = trimmed.slice(LINK_PREFIX.length);
    return code ? { kind: 'link', code } : { kind: 'menu' };
  }
  return { kind: 'menu' };
}
