import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { ru } from './ru';
import { loadLocaleOverlay, type OverlayTree } from './locale-overlay';

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

/**
 * Keep `<html lang>` in step with the active language.
 *
 * `index.html` ships `lang="ru"` and nothing ever changed it, so a screen
 * reader pronounced the whole English interface with a Russian voice. It is
 * also what `getActiveLocale` used to read — which is how every date in the
 * app came out Russian.
 */
function syncDocumentLanguage(lang: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang.startsWith('ru') ? 'ru' : 'en';
}

syncDocumentLanguage(i18n.language ?? 'ru');
i18n.on('languageChanged', syncDocumentLanguage);

/**
 * An operator's own wording, laid over the shipped dictionary.
 *
 * The file is mounted into the container beside `index.html` — see
 * `locale-overlay.ts` for the paths and for why it is an overlay rather than a
 * replacement. Nothing here can stop the cabinet rendering: a missing file is
 * the ordinary case and a broken one is ignored.
 *
 * NOT AWAITED, and the boot is not held for it. `main.tsx` renders at module
 * scope, so blocking here would put a same-origin request in front of first
 * paint for every customer, to spare the handful with an overlay a flicker on
 * their overridden strings alone. The fetch starts during bundle evaluation and
 * has normally landed before React has anything on screen; when it has not,
 * `changeLanguage` re-renders what it changed.
 */
const overlayAttempted = new Set<string>();

async function applyLocaleOverlay(lang: string): Promise<void> {
  const head = normaliseLocale(lang);
  if (head === null || overlayAttempted.has(head)) return;
  // Marked BEFORE the await: `changeLanguage` below emits `languageChanged`,
  // which lands back in this same function, and a second in-flight request
  // would be the least of it — the pair would not terminate.
  overlayAttempted.add(head);
  // The shipped dictionary travels with the request so the sanitiser can refuse
  // an overlay that would DELETE a section rather than reword one. i18next's
  // deep merge lets a string overwrite a whole branch, and an operator writing
  // `{"plans": "Тарифы"}` — a reasonable guess at the format — would otherwise
  // wipe every string under `plans` for every customer.
  const overlay: OverlayTree | null = await loadLocaleOverlay(head, {
    dictionary: i18n.getResourceBundle(head, 'translation') as unknown,
  });
  if (overlay === null) return;
  // `deep` so an overlay naming one string inside a section does not delete the
  // section's other strings; `overwrite` because replacing our wording is the
  // entire purpose.
  i18n.addResourceBundle(head, 'translation', overlay, true, true);
  // `addResourceBundle` mutates the store without telling anybody. react-i18next
  // re-renders on `languageChanged`, which this emits — to the language already
  // active, so nothing else about the session changes.
  if (i18n.language === head) void i18n.changeLanguage(head);
}

void applyLocaleOverlay(i18n.language ?? 'ru');
i18n.on('languageChanged', (next: string) => {
  void applyLocaleOverlay(next);
});

export { i18n };
