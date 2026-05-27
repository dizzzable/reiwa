import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { ru } from './ru';

const STORAGE_KEY = 'reiwa_locale';
const SUPPORTED_LOCALES = new Set(['ru', 'en']);

/**
 * Resolve the user-facing locale at SPA boot.
 *
 * Priority (mirrors the bot's auto-detect logic — see
 * `reiwa/src/bot/i18n.ts#detectLocaleFromTelegram`):
 *   1. Explicit user choice persisted in `localStorage`. The `/lang`
 *      command (bot) and `setLocale(...)` (web) both write here.
 *   2. Telegram Mini App `initDataUnsafe.user.language_code` — present
 *      when the SPA was opened from inside the bot.
 *   3. `navigator.language` — the browser's preferred locale.
 *   4. Hard-coded `ru` baseline.
 *
 * Whatever wins gets normalised to a 2-letter head (`en-GB` → `en`) and
 * then matched against `SUPPORTED_LOCALES`. Anything outside the set
 * falls back to `ru`.
 */
function detectInitialLocale(): string {
  const stored = readStoredLocale();
  if (stored !== null) return stored;

  const tgLang = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  const tgNormalised = normaliseLocale(tgLang);
  if (tgNormalised !== null) return tgNormalised;

  const navLang = typeof navigator !== 'undefined' ? navigator.language : null;
  const navNormalised = normaliseLocale(navLang);
  if (navNormalised !== null) return navNormalised;

  return 'ru';
}

function readStoredLocale(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null && SUPPORTED_LOCALES.has(stored)) return stored;
  } catch {
    /* localStorage unavailable (private mode etc.) — fall through */
  }
  return null;
}

function normaliseLocale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const head = raw.toLowerCase().split(/[-_]/, 1)[0];
  return SUPPORTED_LOCALES.has(head) ? head : null;
}

export function setLocale(lang: 'en' | 'ru'): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  void i18n.changeLanguage(lang);
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: detectInitialLocale(),
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

export { i18n };
