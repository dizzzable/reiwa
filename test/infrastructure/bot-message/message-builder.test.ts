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
      'profile.traffic_extra': 'Трафик доп.',
      'profile.until': 'До',
      'profile.unlimited': 'Безлимит',
      'common.not_available': 'Н/Д',
    },
    en: {
      'profile.subscription': 'Subscription',
      'profile.devices': 'Devices: {{count}} available',
      'profile.devices_unlimited': 'Devices: unlimited',
      'profile.traffic': 'Traffic',
      'profile.traffic_extra': 'Extra traffic',
      'profile.until': 'Until',
      'profile.unlimited': 'Unlimited',
      'common.not_available': 'N/A',
    },
  } as const;
  return {
    t(key, lang, vars) {
      const raw = PACK[lang]?.[key as keyof (typeof PACK)['ru']] ?? key;
      if (vars === undefined) return raw;
      // `reduce<string>`: `raw` is a union of the literal strings in PACK, so
      // without the explicit type argument TS picks the overload whose
      // accumulator is the ENTRY tuple and the whole `t` stops being a
      // `(…) => string`.
      return Object.entries(vars).reduce<string>(
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

  it('prints a zero device limit as unlimited, never as "0 available"', () => {
    const zero = buildProfileSummary({
      firstName: 'A',
      subscriptions: [{ ...ACTIVE_SUB, deviceLimit: 0 }],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'ru',
    });
    expect(zero.text).toContain('Устройств: безлимит');
    expect(zero.text).not.toContain('Устройств: 0');

    // The plans table spells unlimited devices as -1 on some plan types; the
    // subscription payload must read the same to the customer.
    const minusOne = buildProfileSummary({
      firstName: 'A',
      subscriptions: [{ ...ACTIVE_SUB, deviceLimit: -1 }],
      welcomeTemplate: 'Hi',
      translator,
      lang: 'en',
    });
    expect(minusOne.text).toContain('Devices: unlimited');
    expect(minusOne.text).not.toContain('Devices: -1');
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

  // The dot used to be plain unicode: `buildTrafficLine` resolved it with
  // `resolveUnicode`, so a premium emoji bound to TRAFFIC_OK/WARN/FULL never
  // reached the message while the same binding on the leading slot rendered.
  it('renders a premium status dot as its own entity', () => {
    const botEmojis: BotEmojiMap = {
      TRAFFIC_OK: { unicode: '🟢', tgEmojiId: '5275979556308674886' },
    };
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [ACTIVE_SUB],
      welcomeTemplate: 'Hi',
      botEmojis,
      translator,
      lang: 'ru',
    });

    // 0% of the plan → the OK dot; the leading «📈» has no premium id here.
    expect(out.text).toContain('Трафик — 🟢 ░');
    expect(out.entities).toEqual([
      {
        type: 'custom_emoji',
        offset: out.text.indexOf('🟢'),
        length: 2,
        custom_emoji_id: '5275979556308674886',
      },
    ]);
  });

  it('keeps the dot glyph but drops its entity for a non-premium owner', () => {
    const botEmojis: BotEmojiMap = {
      TRAFFIC_OK: { unicode: '🟢', tgEmojiId: '5275979556308674886' },
    };
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [ACTIVE_SUB],
      welcomeTemplate: 'Hi',
      botEmojis,
      ownerHasPremium: false,
      translator,
      lang: 'ru',
    });

    expect(out.text).toContain('Трафик — 🟢 ░');
    expect(out.entities).toEqual([]);
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

  // «Тексты бота» overrides every key in these lines, and its emoji picker
  // writes `{{KEY}}` slots. Only the welcome template's slots were resolved, so
  // one in a line of the mini-profile reached the greeting as `{{GIFT}}`.
  it('resolves bot-emoji slots in the mini-profile lines, each with its entity', () => {
    const operator: TranslatorPort = {
      t: (key, lang, vars) =>
        key.startsWith('profile.') || key === 'common.not_available'
          ? `{{GIFT}} ${translator.t(key, lang, vars)}`
          : translator.t(key, lang, vars),
      resolveButtonLabel: (_id, fallback) => fallback,
    };
    // The subscription line falls to `profile.subscription`, the expiry to
    // `common.not_available`; the second block's traffic line is the unlimited one.
    const bare = { ...ACTIVE_SUB, profileName: null, plan: null, expiresAt: null, expireAt: undefined };
    const out = buildProfileSummary({
      firstName: 'A',
      subscriptions: [bare, { ...bare, id: 2, trafficLimit: null }],
      // A pack emoji ahead of every line, so the slots' entities have to be re-based past it.
      welcomeTemplate: ':fire: Hi',
      botEmojis: { GIFT: { unicode: '🎁', tgEmojiId: '5203996991054432397' } },
      customEmojis: { fire: { id: '5368324170671202286', fallback: '🔥' } },
      translator: operator,
      lang: 'ru',
    });

    expect(out.text).not.toContain('{{');
    // Per block: subscription, devices, traffic and the expiry line twice («До»,
    // «Н/Д») — and the unlimited traffic line once more, for «Безлимит».
    const gifts = [...out.text.matchAll(/🎁/gu)].map((match) => match.index);
    expect(gifts).toHaveLength(11);
    const giftEntities = out.entities.filter((e) => e.custom_emoji_id === '5203996991054432397');
    expect(giftEntities.map((e) => e.offset).sort((a, b) => a - b)).toEqual(gifts);
    expect(giftEntities.every((e) => e.length === 2)).toBe(true);
    expect(out.entities.filter((e) => e.custom_emoji_id === '5368324170671202286')).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5368324170671202286' },
    ]);
  });

  // The owner's own layout for an объединённая подписка (14.11.2026): ONE block,
  // the visible plan's profile line, and every plan of the bundle as a traffic
  // line — an unlimited plan always first, the limited ones after it under
  // «Трафик доп.» — never two full mini-profiles for what the app shows as a
  // single link.
  describe('a merged subscription (plan bundle)', () => {
    const bundle = { bundleId: 'b1', bundleName: 'Безлимит + докупка', visiblePlanId: '8' };
    const unlimited: Subscription = {
      ...ACTIVE_SUB,
      id: 21,
      profileName: 'rz_unlimited',
      trafficLimit: null,
      trafficUsed: 0,
      plan: { id: 7, name: 'Безлимит', type: 'UNLIMITED' },
      merge: bundle,
    };
    const limited: Subscription = {
      ...ACTIVE_SUB,
      id: 22,
      profileName: 'rz_limited',
      trafficLimit: 50,
      trafficUsed: 0.1,
      plan: { id: 8, name: 'Обходы', type: 'BOTH' },
      merge: bundle,
    };

    it('draws one block with the unlimited plan on the first traffic line', () => {
      const out = buildProfileSummary({
        firstName: 'A',
        // Deliberately the order that would put the unlimited plan first.
        subscriptions: [unlimited, limited],
        welcomeTemplate: 'Hi',
        translator,
        lang: 'ru',
      });

      expect(out.text.split('rz_limited')).toHaveLength(2); // exactly once
      expect(out.text).not.toContain('rz_unlimited');
      expect(out.text.split('Устройств:').length - 1).toBe(1);
      expect(out.text.split('До:').length - 1).toBe(1);
      // Owner's rule (14.11.2026): the unlimited plan ALWAYS leads the traffic
      // lines; the limited one follows under «Трафик доп.» and never the other
      // way round.
      expect(out.text).toContain('Трафик — 🟢 Безлимит');
      expect(out.text).toContain('Трафик доп. — ');
      expect(out.text).toContain('(0.10 / 50.00 GB)');
      expect(out.text).not.toContain('Трафик доп. — 🟢 Безлимит');
    });

    it('labels the extra line from the operator’s own «Тексты бота» override', () => {
      const renamed: TranslatorPort = {
        t: (key, lang, vars) =>
          key === 'profile.traffic_extra' ? 'Обходы' : translator.t(key, lang, vars),
        resolveButtonLabel: (_id, fallback) => fallback,
      };
      const out = buildProfileSummary({
        firstName: 'A',
        subscriptions: [unlimited, limited],
        welcomeTemplate: 'Hi',
        translator: renamed,
        lang: 'ru',
      });

      // The renamed caption belongs to the LIMITED line; the unlimited one keeps
      // «Трафик» and its «Безлимит» text.
      expect(out.text).toContain('Обходы — ');
      expect(out.text).toContain('(0.10 / 50.00 GB)');
      expect(out.text).toContain('Трафик — 🟢 Безлимит');
    });

    it('gives every limited line its own caption window and falls back without one', () => {
      const third: Subscription = {
        ...ACTIVE_SUB,
        id: 23,
        profileName: 'rz_more',
        trafficLimit: 150,
        trafficUsed: 0,
        plan: { id: 9, name: 'Третья', type: 'BOTH' },
        merge: bundle,
      };
      const labelled: TranslatorPort = {
        t: (key, lang, vars) =>
          key === 'profile.traffic_extra_2' ? 'Вторая доп.' : translator.t(key, lang, vars),
        resolveButtonLabel: (_id, fallback) => fallback,
      };
      const out = buildProfileSummary({
        firstName: 'A',
        subscriptions: [unlimited, limited, third],
        welcomeTemplate: 'Hi',
        translator: labelled,
        lang: 'ru',
      });

      // First limited line: the base caption; second one: its own window.
      expect(out.text).toContain('Трафик доп. — ');
      expect(out.text).toContain('Вторая доп. — ');
      expect(out.text).toContain('(0.10 / 50.00 GB)');
      expect(out.text).toContain('(0.00 / 150.00 GB)');

      const withoutWindow = buildProfileSummary({
        firstName: 'A',
        subscriptions: [unlimited, limited, third],
        welcomeTemplate: 'Hi',
        translator,
        lang: 'ru',
      });
      // No window added yet: both limited lines still read «Трафик доп.».
      expect(withoutWindow.text.split('Трафик доп. — ').length - 1).toBe(2);
    });

    it('keeps the visible limited plan on the first line when the bundle has no unlimited plan', () => {
      const second: Subscription = {
        ...ACTIVE_SUB,
        id: 24,
        profileName: 'rz_second',
        trafficLimit: 150,
        trafficUsed: 0,
        plan: { id: 9, name: 'Третья', type: 'BOTH' },
        merge: bundle,
      };
      const out = buildProfileSummary({
        firstName: 'A',
        subscriptions: [second, limited],
        welcomeTemplate: 'Hi',
        translator,
        lang: 'ru',
      });

      const firstTrafficLine = out.text
        .split('\n')
        .find((line) => line.includes('Трафик — '));
      // The card the app faces is the visible plan (50 GB), so its numbers lead.
      expect(firstTrafficLine).toContain('(0.10 / 50.00 GB)');
      expect(out.text.split('Трафик доп. — ').length - 1).toBe(1);
      expect(out.text).toContain('(0.00 / 150.00 GB)');
    });

    it('gives the extra line its own premium emoji slot', () => {
      const botEmojis: BotEmojiMap = {
        SUB_TRAFFIC_EXTRA: { unicode: '🔀', tgEmojiId: '5271604874428611089' },
      };
      const out = buildProfileSummary({
        firstName: 'A',
        subscriptions: [unlimited, limited],
        welcomeTemplate: 'Hi',
        botEmojis,
        translator,
        lang: 'ru',
      });

      expect(out.text).toContain('🔀');
      expect(out.entities).toContainEqual({
        type: 'custom_emoji',
        offset: out.text.indexOf('🔀'),
        length: 2,
        custom_emoji_id: '5271604874428611089',
      });
    });

    // A merged bundle draws the same status indicator on EVERY traffic line, so
    // a premium emoji bound to a dot slot must render on «Трафик доп.» lines
    // too — not just on the single-plan greeting.
    it('renders a premium status dot on the extra line of a merged bundle', () => {
      const nearLimit: Subscription = { ...limited, trafficUsed: 45 }; // 90%
      const botEmojis: BotEmojiMap = {
        TRAFFIC_WARN: { unicode: '🟠', tgEmojiId: '5200000000000000001' },
      };
      const out = buildProfileSummary({
        firstName: 'A',
        subscriptions: [unlimited, nearLimit],
        welcomeTemplate: 'Hi',
        botEmojis,
        translator,
        lang: 'ru',
      });

      // The unlimited first line keeps the plain OK dot; the limited extra line
      // (90 %) renders the WARN dot as an entity.
      expect(out.text).toContain('Трафик — 🟢 Безлимит');
      expect(out.text).toContain('Трафик доп. — 🟠');
      const dots = out.entities.filter((e) => e.custom_emoji_id === '5200000000000000001');
      expect(dots).toEqual([
        {
          type: 'custom_emoji',
          offset: out.text.indexOf('🟠'),
          length: 2,
          custom_emoji_id: '5200000000000000001',
        },
      ]);
    });

    it('keeps subscriptions of the same bundle apart only while the merge is unknown', () => {
      const out = buildProfileSummary({
        firstName: 'A',
        subscriptions: [
          { ...unlimited, merge: null },
          { ...limited, merge: null },
        ],
        welcomeTemplate: 'Hi',
        translator,
        lang: 'ru',
      });

      expect(out.text).toContain('rz_unlimited');
      expect(out.text).toContain('rz_limited');
      expect(out.text.split('Устройств:').length - 1).toBe(2);
    });
  });
});
