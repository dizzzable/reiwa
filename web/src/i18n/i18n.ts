import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { ru } from './ru';

const STORAGE_KEY = 'reiwa_locale';

function getStoredLocale(): string {
  // 1. Try localStorage
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'ru' || stored === 'en') return stored;
  } catch {
    /* ignore */
  }
  // 2. Try Telegram WebApp language
  const tgLang = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  if (tgLang?.startsWith('ru')) return 'ru';
  // 3. Try navigator
  if (navigator.language?.startsWith('ru')) return 'ru';
  return 'ru'; // default to Russian (VPN audience)
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
  lng: getStoredLocale(),
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

export { i18n };
