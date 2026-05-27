/**
 * Re-export shim for the legacy `./i18n` import path used by `bot/main.ts`.
 *
 * Wave 1B relocated the i18n implementation to
 * `src/infrastructure/i18n/{packs,translator,locale-detector}/`. This
 * file preserves the old function-style surface so the bot god-file
 * keeps compiling untouched until Wave 3 rewrites it on top of the
 * `TranslatorPort` DI surface.
 *
 * Anything new should depend on `application/ports/translator.port`
 * and resolve the implementation through DI — do not add new exports
 * here.
 */
import type { SupportedLocale } from '../core/enums/locale.enum.js';
import { isSupportedLocale, DEFAULT_LOCALE } from '../core/enums/locale.enum.js';
import {
  detectLocaleFromTelegram as detectLocaleFromTelegramImpl,
  formatDays as formatDaysImpl,
  RU_PACK,
  translator,
  userLocaleCache,
} from '../infrastructure/i18n/index.js';

/**
 * Legacy alias for the hard-coded Russian baseline pack. Kept for the
 * rare callers (e.g. test fixtures) that imported `RU` directly from
 * `./i18n`. New code should not depend on this object — use
 * `TranslatorPort.t()` instead.
 */
export const RU: Readonly<Record<string, string>> = RU_PACK;

/** Coerce arbitrary user input to a `SupportedLocale`, falling back to RU. */
function coerceLocale(lang: string | SupportedLocale | undefined): SupportedLocale {
  if (lang === undefined) return DEFAULT_LOCALE;
  const lower = typeof lang === 'string' ? lang.toLowerCase() : lang;
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

export function setTranslations(translations: Record<string, unknown> | undefined | null): void {
  if (!translations) {
    translator.setOverrides(null);
    return;
  }
  const stringMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(translations)) {
    if (typeof v === 'string') stringMap[k] = v;
  }
  translator.setOverrides(stringMap);
}

export function t(key: string, lang: string = DEFAULT_LOCALE, vars?: Record<string, string | number>): string {
  return translator.t(key, coerceLocale(lang), vars);
}

export function formatDays(n: number, lang: string = DEFAULT_LOCALE): string {
  return formatDaysImpl(n, coerceLocale(lang));
}

export function setUserLang(userId: number, lang: string): void {
  userLocaleCache.setSync(userId, lang);
}

export function getUserLang(userId: number): string {
  return userLocaleCache.getSync(userId);
}

export function userLangCacheHas(userId: number): boolean {
  return userLocaleCache.hasSync(userId);
}

export function detectLocaleFromTelegram(rawLanguageCode: string | undefined | null): string {
  return detectLocaleFromTelegramImpl(rawLanguageCode);
}

export function resolveButtonLabel(
  buttonId: string,
  fallbackLabel: string,
  translations: Readonly<Record<string, string>>,
  lang: string,
): string {
  // The legacy signature accepted a live `translations` map (the raw
  // bot-config response) so the bot god-file could resolve labels
  // without first calling `setTranslations`. Honour that: try the live
  // map's `button.<id>.<lang>` key before delegating to the translator.
  const lower = lang.toLowerCase();
  const fullKey = `button.${buttonId}.${lower}`;
  const direct = translations[fullKey];
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  return translator.resolveButtonLabel(buttonId, fallbackLabel, coerceLocale(lower));
}
