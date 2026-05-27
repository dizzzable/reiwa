/**
 * Locale detector + UserLocaleCache specs.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  detectLocaleFromTelegram,
  UserLocaleCache,
} from '../../../src/infrastructure/i18n/locale-detector/locale-detector.js';

describe('detectLocaleFromTelegram', () => {
  it('returns the RU default for null/undefined/empty input', () => {
    expect(detectLocaleFromTelegram(null)).toBe('ru');
    expect(detectLocaleFromTelegram(undefined)).toBe('ru');
    expect(detectLocaleFromTelegram('')).toBe('ru');
  });

  it('matches a 2-letter supported locale exactly', () => {
    expect(detectLocaleFromTelegram('en')).toBe('en');
    expect(detectLocaleFromTelegram('ru')).toBe('ru');
  });

  it('strips region tags (en-GB → en, ru-RU → ru, pt-BR → ru fallback)', () => {
    expect(detectLocaleFromTelegram('en-GB')).toBe('en');
    expect(detectLocaleFromTelegram('en_US')).toBe('en');
    expect(detectLocaleFromTelegram('ru-RU')).toBe('ru');
    expect(detectLocaleFromTelegram('pt-BR')).toBe('ru');
  });

  it('lowercases mixed-case input before matching', () => {
    expect(detectLocaleFromTelegram('EN')).toBe('en');
    expect(detectLocaleFromTelegram('En-Gb')).toBe('en');
  });

  it('maps russian-script kindred locales (be, uk, kk) to RU', () => {
    expect(detectLocaleFromTelegram('be')).toBe('ru');
    expect(detectLocaleFromTelegram('uk')).toBe('ru');
    expect(detectLocaleFromTelegram('kk')).toBe('ru');
    expect(detectLocaleFromTelegram('uk-UA')).toBe('ru');
  });

  it('falls back to RU for any other unsupported locale', () => {
    expect(detectLocaleFromTelegram('fr')).toBe('ru');
    expect(detectLocaleFromTelegram('de')).toBe('ru');
    expect(detectLocaleFromTelegram('zh-CN')).toBe('ru');
  });
});

describe('UserLocaleCache', () => {
  let cache: UserLocaleCache;

  beforeEach(() => {
    cache = new UserLocaleCache();
  });

  it('returns the RU default for an unknown user id', () => {
    expect(cache.get(12345)).toBe('ru');
    expect(cache.has(12345)).toBe(false);
  });

  it('persists writes for subsequent reads', () => {
    cache.set(42, 'en');
    expect(cache.get(42)).toBe('en');
    expect(cache.has(42)).toBe(true);
  });

  it('lowercases the supplied locale before storing', () => {
    cache.set(7, 'EN');
    expect(cache.get(7)).toBe('en');
  });

  it('coerces unknown locales to the RU default rather than storing them verbatim', () => {
    cache.set(1, 'fr');
    expect(cache.get(1)).toBe('ru');
    // Still considered "set" — we recorded our decision; subsequent calls
    // should not retry detection on this user.
    expect(cache.has(1)).toBe(true);
  });

  it('reset() wipes all entries', () => {
    cache.set(1, 'en');
    cache.set(2, 'ru');
    cache.reset();
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(false);
  });
});
