/**
 * Locale resolution from external signals.
 *
 * Two responsibilities:
 *   1. `detectLocaleFromTelegram(language_code)` — map a Telegram-supplied
 *      BCP-47-ish code (`en`, `en-GB`, `pt-BR`) to a `SupportedLocale`,
 *      with a Russian-script fallback for kindred locales (be/uk/kk).
 *   2. Per-user locale cache — small in-memory map (keyed by Telegram
 *      `from.id`) that survives the bot process. Wave 8 will swap this
 *      for a Redis-backed store; the API is intentionally identical so
 *      callers do not need to change.
 *
 * The cache is process-local and resets on bot restart. That is fine for
 * a UX where the auto-detect middleware re-applies the device locale on
 * the very next message — the cache only matters within a single grammy
 * conversation turn anyway.
 */
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  isSupportedLocale,
} from '../../../core/enums/locale.enum.js';

const SUPPORTED_LOCALE_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

/**
 * Maps a Telegram-supplied `language_code` (BCP-47-ish: `en`, `en-GB`,
 * `ru`, `pt-BR`, ...) onto the closest supported locale.
 *
 * Telegram clients deliver the *system* language of the device, so this
 * is the authoritative auto-detect signal: if a user's phone is set to
 * English, Telegram sends `en` and we render English on the very first
 * message, no `/lang` round-trip required.
 */
export function detectLocaleFromTelegram(rawLanguageCode: string | undefined | null): SupportedLocale {
  if (!rawLanguageCode) return DEFAULT_LOCALE;
  const lower = rawLanguageCode.toLowerCase();
  // Strip region tag (`en-GB` → `en`) and re-check against the supported set.
  const head = lower.split(/[-_]/, 1)[0];
  if (SUPPORTED_LOCALE_SET.has(head) && isSupportedLocale(head)) return head;
  // Russian-script clones (`be`, `uk`, `kk`) get Russian — the
  // hard-coded baseline is closer to them than English. Easy to extend
  // later if a dedicated pack ships.
  if (head === 'be' || head === 'uk' || head === 'kk') return 'ru';
  return DEFAULT_LOCALE;
}

/**
 * Per-user locale cache. Backed by an in-memory `Map` for now; will be
 * swapped for a Redis-backed implementation in Wave 8 without changing
 * the surface API.
 */
export class UserLocaleCache {
  private readonly cache = new Map<number, SupportedLocale>();

  set(userId: number, lang: string | SupportedLocale): void {
    const lower = typeof lang === 'string' ? lang.toLowerCase() : lang;
    if (isSupportedLocale(lower)) {
      this.cache.set(userId, lower);
      return;
    }
    // Unknown locale → store the default so we don't silently keep
    // looking up an unsupported tag on every turn.
    this.cache.set(userId, DEFAULT_LOCALE);
  }

  get(userId: number): SupportedLocale {
    return this.cache.get(userId) ?? DEFAULT_LOCALE;
  }

  has(userId: number): boolean {
    return this.cache.has(userId);
  }

  /** Test seam — clears the cache between unit tests. */
  reset(): void {
    this.cache.clear();
  }
}

/** Process-wide singleton — Wave 8 will replace the constructor here. */
export const userLocaleCache = new UserLocaleCache();
