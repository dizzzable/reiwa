/**
 * Bot message builder specs — buildProfileSummary.
 *
 * Pins the rendered output of the greeting + per-subscription mini-profile
 * so admin-editable copy keeps producing the expected layout, custom_emoji
 * entities, and translation interpolation. UTF-16 entity offset arithmetic
 * is covered separately in `emoji-utils.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { buildProfileSummary } from '../../../src/infrastructure/bot-message/message-builder.js';
import type {
  BotEmojiMap,
  Subscription,
} from '../../../src/infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';

/**
 * Stub translator that ships RU + EN packs for the keys this module
 * exercises. `vars` are interpolated via the same `{{name}}` shape as
 * the production translator so we cover the count/days flow without
 * pulling in the full Translator implementation.
 */
function buildStubTranslator(): TranslatorPort {
  const PACK = {
    ru: {
      'profile.subscription': 'Подписка',
      'profile.devices': 'Устройств: {{count}} доступно',
      'profile.devices_unlimited': 'Устройств: безлимит',
      'profile.traffic': 'Трафик',
      'profile.until': 'До',
      'profile.unlimited': 'Безлимит',
      'common.not_available': 'Н/Д',
    },
    en: {
      'profile.subscription': 'Subscription',
      'profile.devices': 'Devices: {{count}} available',
      'profile.devices_unlimited': 'Devices: unlimited',
      'profile.traffic': 'Traffic',
      'profile.until': 'Until',
      'profile.unlimited': 'Unlimited',
      'common.not_available': 'N/A',
    },
  } as const;
  return {
    t(key, lang, vars) {
      const raw = PACK[lang]?.[key as keyof (typeof PACK)['ru']] ?? key;
      if (vars === undefined) return raw;
      return Object.entries(vars).reduce(
        (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v)),
        raw,
      );
    },
    resolveButtonLabel: (_id, fallback) => fallback,
  };
}

const ACTIVE_SUB: Subscription = {
  id: 1,
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: 10,
  trafficUsed: 0,
  deviceLimit: 1,
  expireAt: '2026-12-31T00:00:00.000Z',
  expiresAt: '2026-12-31T00:00:00.000Z',
  profileName: 'rz_user_sub',
  url: 'https://example.com/sub/1',
  plan: { id: 1, name: 'Premium', type: 'STANDARD' },
};

describe('buildProfileSummary', () => {
  const translator = buildStubTranslator();

  it('returns the welcome text alone when the user has no subscriptions', () => {
    const out = buildProfileSummary({
      firstName: 'Аня',
      subscriptions: [],
      welcomeTemplate: 'Привет, {{firstName}}!',
      translator,
      lang: 'ru',
    });
    expect(out.text).toBe('Привет, Аня!');
    expect(out.entities).toEqual([]);
  });

  it('substitutes {{firstName}} into the welcome template', () => {
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [ACTIVE_SUB],
      welcomeTemplate: 'Hi {{firstName}}',
      translator,
      lang: 'en',
    });
    expect(out.text).toContain('Hi A');
  });

  it('renders one block per subscription with profile name + devices + traffic + expiry (ru)', () => {
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [ACTIVE_SUB],
      welcomeTemplate: 'Hi {{firstName}}',
      translator,
      lang: 'ru',
    });
    expect(out.text).toContain('rz_user_sub');
    expect(out.text).toContain('Устройств: 1 доступно');
    expect(out.text).toContain('Трафик');
    expect(out.text).toContain('0% (0.00 / 10.00 GB)');
    expect(out.text).toContain('До:');
    expect(out.text).toContain('31.12.2026');
  });

  it('uses the en pack labels when lang=en', () => {
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [ACTIVE_SUB],
      welcomeTemplate: 'Hi {{firstName}}',
      translator,
      lang: 'en',
    });
    expect(out.text).toContain('Devices: 1 available');
    expect(out.text).toContain('Traffic');
    expect(out.text).toContain('Until:');
  });

  it('renders unlimited traffic without a percentage bar when trafficLimit is null', () => {
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [{ ...ACTIVE_SUB, trafficLimit: null }],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'ru',
    });
    expect(out.text).toContain('Безлимит');
    expect(out.text).not.toContain('0%');
  });

  it('falls back to the plan name, then to "Подписка", when profileName is empty', () => {
    const fallbackToPlan = buildProfileSummary({
      firstName: 'A',
      subscriptions: [{ ...ACTIVE_SUB, profileName: null }],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'ru',
    });
    expect(fallbackToPlan.text).toContain('Premium');

    const fallbackToKey = buildProfileSummary({
      firstName: 'A',
      subscriptions: [{ ...ACTIVE_SUB, profileName: null, plan: null }],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'ru',
    });
    expect(fallbackToKey.text).toContain('Подписка');
  });

  it('emits a custom_emoji entity for SUB_PROFILE when configured', () => {
    const botEmojis: BotEmojiMap = {
      SUB_PROFILE: { unicode: '👤', tgEmojiId: '5275979556308674886' },
    };
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [ACTIVE_SUB],
      welcomeTemplate: 'Hi',
      botEmojis,
      translator,
      lang: 'ru',
    });
    expect(out.entities).toContainEqual(
      expect.objectContaining({
        type: 'custom_emoji',
        custom_emoji_id: '5275979556308674886',
      }),
    );
  });

  it('skips DELETED subscriptions', () => {
    const deleted: Subscription = { ...ACTIVE_SUB, status: 'DELETED', profileName: 'rz_old' };
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [deleted],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'ru',
    });
    expect(out.text).toBe('Hi');
    expect(out.text).not.toContain('rz_old');
  });

  it('falls back to translated "not available" when expiry is missing', () => {
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [{ ...ACTIVE_SUB, expiresAt: null, expireAt: undefined }],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'ru',
    });
    expect(out.text).toContain('До: Н/Д');
  });
});
