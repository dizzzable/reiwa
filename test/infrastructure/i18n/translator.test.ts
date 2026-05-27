/**
 * Translator unit specs.
 *
 * Each test instantiates a fresh `Translator` rather than reusing the
 * process-wide singleton — that way operator-override state from one
 * test never leaks into another and the test order is irrelevant.
 */
import { describe, expect, it } from 'vitest';

import { RU_PACK } from '../../../src/infrastructure/i18n/packs/index.js';
import { Translator } from '../../../src/infrastructure/i18n/translator/translator.js';

describe('Translator.t — built-in pack lookup', () => {
  it('returns the RU baseline for the default locale', () => {
    const t = new Translator();
    expect(t.t('menu.choose_action', 'ru')).toBe(RU_PACK['menu.choose_action']);
  });

  it('returns the EN pack value for an English request', () => {
    const t = new Translator();
    expect(t.t('menu.choose_action', 'en')).toBe('Choose an action:');
  });

  it('falls back to RU when the requested locale lacks a key', () => {
    // Built-in packs are intentionally synchronised today, so we
    // exercise the fallback chain by registering an RU-only operator
    // override and asking for the EN form. The lookup order is:
    //   1. operator override for `en` — miss
    //   2. built-in EN pack — miss for `made.up.key`
    //   3. operator override for `ru` — hit
    const t = new Translator();
    t.setOverrides({ 'ru.made.up.key': 'Только для RU' });
    expect(t.t('made.up.key', 'en')).toBe('Только для RU');
  });

  it('returns the raw key when no pack resolves it', () => {
    const t = new Translator();
    expect(t.t('does.not.exist', 'ru')).toBe('does.not.exist');
  });
});

describe('Translator.t — variable interpolation', () => {
  it('substitutes {{var}} placeholders', () => {
    const t = new Translator();
    const result = t.t('invite.share', 'ru', { link: 'https://example.com' });
    expect(result).toContain('https://example.com');
    expect(result).not.toContain('{{link}}');
  });

  it('coerces numeric vars to strings', () => {
    const t = new Translator();
    const result = t.t('subscription.status', 'ru', { status: 42 });
    expect(result).toContain('42');
  });

  it('leaves unknown placeholders untouched', () => {
    const t = new Translator();
    const result = t.t('subscription.status', 'ru', {});
    expect(result).toContain('{{status}}');
  });
});

describe('Translator.setOverrides — operator pack precedence', () => {
  it('honours per-locale-namespaced shape ("en.menu.choose_action")', () => {
    const t = new Translator();
    t.setOverrides({ 'en.menu.choose_action': 'Pick something' });
    expect(t.t('menu.choose_action', 'en')).toBe('Pick something');
    // RU is still the built-in baseline.
    expect(t.t('menu.choose_action', 'ru')).toBe(RU_PACK['menu.choose_action']);
  });

  it('honours per-key-suffix shape ("menu.choose_action.en")', () => {
    const t = new Translator();
    t.setOverrides({ 'menu.choose_action.en': 'Pick something else' });
    expect(t.t('menu.choose_action', 'en')).toBe('Pick something else');
  });

  it('treats unprefixed keys as RU baseline overrides', () => {
    const t = new Translator();
    t.setOverrides({ 'menu.choose_action': 'Действуй' });
    expect(t.t('menu.choose_action', 'ru')).toBe('Действуй');
  });

  it('lets EN-locale overrides win over the built-in EN pack', () => {
    const t = new Translator();
    t.setOverrides({ 'en.menu.choose_action': 'Override wins' });
    expect(t.t('menu.choose_action', 'en')).toBe('Override wins');
  });

  it('rejects 2-letter prefixes that are not SupportedLocale (e.g. "fr")', () => {
    const t = new Translator();
    t.setOverrides({ 'fr.menu.choose_action': 'Choisis une action' });
    // No `fr` pack exists, so this lookup falls back to RU baseline.
    expect(t.t('menu.choose_action', 'ru')).toBe(RU_PACK['menu.choose_action']);
  });

  it('clears overrides on null/undefined input', () => {
    const t = new Translator();
    t.setOverrides({ 'menu.choose_action': 'overridden' });
    expect(t.t('menu.choose_action', 'ru')).toBe('overridden');
    t.setOverrides(null);
    expect(t.t('menu.choose_action', 'ru')).toBe(RU_PACK['menu.choose_action']);
  });

  it('honours the legacy "bot." prefix on override keys', () => {
    const t = new Translator();
    // STEALTHNET layout: operators sometimes namespace keys under `bot.`.
    t.setOverrides({ 'en.bot.menu.choose_action': 'Bot-prefixed' });
    expect(t.t('menu.choose_action', 'en')).toBe('Bot-prefixed');
  });
});

describe('Translator.resolveButtonLabel', () => {
  it('returns the built-in fallback when no override is registered', () => {
    const t = new Translator();
    expect(t.resolveButtonLabel('cabinet', 'My cabinet', 'en')).toBe('My cabinet');
  });

  it('honours button.<id>.<lang> overrides', () => {
    const t = new Translator();
    t.setOverrides({ 'en.button.cabinet.en': 'Account' });
    expect(t.resolveButtonLabel('cabinet', 'My cabinet', 'en')).toBe('Account');
  });

  it('honours generic button.<id> override (locale-agnostic)', () => {
    const t = new Translator();
    t.setOverrides({ 'en.button.cabinet': 'Account' });
    expect(t.resolveButtonLabel('cabinet', 'Fallback', 'en')).toBe('Account');
  });

  it('treats whitespace-only overrides as missing', () => {
    const t = new Translator();
    t.setOverrides({ 'en.button.cabinet.en': '   ' });
    expect(t.resolveButtonLabel('cabinet', 'Fallback', 'en')).toBe('Fallback');
  });
});

describe('Translator.reset', () => {
  it('wipes operator overrides without touching the built-in packs', () => {
    const t = new Translator();
    t.setOverrides({ 'en.menu.choose_action': 'overridden' });
    expect(t.t('menu.choose_action', 'en')).toBe('overridden');
    t.reset();
    expect(t.t('menu.choose_action', 'en')).toBe('Choose an action:');
  });
});
