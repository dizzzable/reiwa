/**
 * SupportedLocale enumerates the languages reiwa ships translation packs for.
 *
 * Mirrors the `Locale` Prisma enum on rezeis-admin (uppercase 2-letter ISO).
 * On the wire we store / accept lower-case (`ru`, `en`) — the upper-case form
 * is admin-side only.
 */
export const SUPPORTED_LOCALES = ['ru', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'ru';

/**
 * Type guard for use cases that ingest user-supplied locale strings (e.g.
 * Telegram `language_code` or HTTP `Accept-Language`). Anything outside the
 * supported set falls back to the default.
 */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
