/**
 * Coerce a free-form locale string (the legacy `userLocale.getSync`
 * contract returns `string`) onto the typed `SupportedLocale` set.
 *
 * Lower-cases and falls back to `DEFAULT_LOCALE` when the input is
 * outside the supported set. Pages call this on every entry point so
 * downstream calls (TranslatorPort, keyboard widget) only ever see
 * the typed shape.
 *
 * Wave 8 will replace `userLocale: UserLocaleSyncCache` with a
 * `UserLocaleCachePort` async surface; this helper folds away then.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';

export function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}
