/**
 * Trial button resolver specs (web-cabinet-onboarding Property 5/6/10/11):
 *   - hidden for subscribers and when no trial is offered / no target exists
 *   - shown free vs paid with the right label + price interpolation
 *   - always primary; premium icon when configured, unicode fallback otherwise
 */
import { describe, expect, it } from 'vitest';

import { resolveTrialButton } from '../../../src/bot/widgets/trial-button.js';
import type { BotEmojiMap } from '../../../src/infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';

const translator: TranslatorPort = {
  t: (key, _lang, params) => {
    if (params && typeof params['price'] === 'string') {
      return `${key}:${params['price']}`;
    }
    return key;
  },
  resolveButtonLabel: (_id, fallback) => fallback,
};

const baseInputs = {
  hasActiveSubscription: false,
  eligibility: { eligible: true, reason: null } as { eligible: boolean; reason: string | null },
  paidTrialPriceLabel: null as string | null,
  miniAppUrl: 'https://example.com/app',
  cabinetUrl: 'https://example.com/dashboard?signin=abc',
  botEmojis: {} as BotEmojiMap | null | undefined,
  translator,
  lang: 'ru' as const,
};

describe('resolveTrialButton', () => {
  it('hides the button for an active subscriber (Property 10)', () => {
    expect(resolveTrialButton({ ...baseInputs, hasActiveSubscription: true })).toBeNull();
  });

  it('hides the button when no cabinet target exists', () => {
    expect(
      resolveTrialButton({ ...baseInputs, miniAppUrl: null, cabinetUrl: null }),
    ).toBeNull();
  });

  it('hides the button when the trial is not offered', () => {
    expect(
      resolveTrialButton({
        ...baseInputs,
        eligibility: { eligible: false, reason: 'TRIAL_NOT_CONFIGURED' },
      }),
    ).toBeNull();
    expect(resolveTrialButton({ ...baseInputs, eligibility: null })).toBeNull();
  });

  it('renders a free trial button with the unicode fallback glyph', () => {
    const spec = resolveTrialButton(baseInputs);
    expect(spec).not.toBeNull();
    expect(spec?.text).toContain('menu.btn_trial_free');
    expect(spec?.text).toContain('🆓'); // DEFAULT_UNICODE.TRIAL fallback
    expect(spec?.iconCustomEmojiId).toBeNull();
    expect(spec?.miniAppUrl).toBe(baseInputs.miniAppUrl);
    expect(spec?.url).toBe(baseInputs.cabinetUrl);
  });

  it('uses the premium custom emoji and drops the unicode prefix when configured', () => {
    const spec = resolveTrialButton({
      ...baseInputs,
      botEmojis: { TRIAL: { unicode: '🆓', tgEmojiId: '555' } },
    });
    expect(spec?.iconCustomEmojiId).toBe('555');
    expect(spec?.text).toBe('menu.btn_trial_free'); // no unicode prefix
  });

  it('falls back to the GIFT registry key for the premium emoji when TRIAL is unset', () => {
    const spec = resolveTrialButton({
      ...baseInputs,
      botEmojis: { GIFT: { unicode: '🎁', tgEmojiId: '5276422526350681413' } },
    });
    expect(spec?.iconCustomEmojiId).toBe('5276422526350681413');
    expect(spec?.text).toBe('menu.btn_trial_free');
  });

  it('renders a paid trial button carrying the price', () => {
    const spec = resolveTrialButton({
      ...baseInputs,
      eligibility: { eligible: false, reason: 'TRIAL_REQUIRES_PAYMENT' },
      paidTrialPriceLabel: '$2.00',
    });
    expect(spec).not.toBeNull();
    expect(spec?.text).toContain('menu.btn_trial_paid');
    expect(spec?.text).toContain('$2.00');
  });
});

// Both labels are translator keys «Тексты бота» can override, with the panel's
// emoji picker in the field. A caption carries no entities, so the label is
// drawn the way every other operator caption is (`renderButtonLabel`): a
// leading pack emoji with a premium id becomes the button's icon, every other
// token its glyph. Unrendered, the button read `:fire:`.
describe('resolveTrialButton — the operator’s emoji tokens in the label', () => {
  const FIRE = '5368324170671202286';
  const customEmojis = { fire: { id: FIRE, fallback: '🔥' } };
  const operator = (label: string): TranslatorPort => ({
    t: (_key, _lang, params) => label.split('{{price}}').join(String(params?.['price'] ?? '')),
    resolveButtonLabel: (_id, fallback) => fallback,
  });

  it('promotes a leading pack emoji to the icon, in place of the registry’s', () => {
    const spec = resolveTrialButton({
      ...baseInputs,
      botEmojis: { TRIAL: { unicode: '🆓', tgEmojiId: '555' } },
      customEmojis,
      ownerHasPremium: true,
      translator: operator(':fire: Попробовать {{GIFT}}'),
    });
    expect({ text: spec?.text, icon: spec?.iconCustomEmojiId }).toEqual({ text: 'Попробовать 🎁', icon: FIRE });
  });

  // Telegram draws `icon_custom_emoji_id` only for an owner with Premium, and
  // the registry icon used to be set regardless — while the glyph that stands
  // in for it was dropped, so a non-Premium owner's trial button lost its emoji.
  it('gives an owner without Premium the registry’s glyph in front, not an icon', () => {
    const spec = resolveTrialButton({
      ...baseInputs,
      botEmojis: { TRIAL: { unicode: '🆓', tgEmojiId: '555' } },
      ownerHasPremium: false,
    });
    expect({ text: spec?.text, icon: spec?.iconCustomEmojiId }).toEqual({
      text: '🆓 menu.btn_trial_free',
      icon: null,
    });
  });

  it('keeps the registry’s glyph in front of a label whose tokens are all glyphs', () => {
    const spec = resolveTrialButton({
      ...baseInputs,
      customEmojis,
      ownerHasPremium: false,
      eligibility: { eligible: false, reason: 'TRIAL_REQUIRES_PAYMENT' },
      paidTrialPriceLabel: '$2.00',
      translator: operator('Попробовать :fire: за {{price}} {{GIFT}}'),
    });
    expect({ text: spec?.text, icon: spec?.iconCustomEmojiId }).toEqual({
      text: '🆓 Попробовать 🔥 за $2.00 🎁',
      icon: null,
    });
  });
});
