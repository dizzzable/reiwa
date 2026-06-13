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
