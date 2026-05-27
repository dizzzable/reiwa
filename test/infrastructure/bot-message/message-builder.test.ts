/**
 * Bot message builder specs.
 *
 * These pin the rendered output of the welcome / subscription /
 * plans / referral payload builders so the Wave 3 bot rewrite can
 * swap the call-site without regressing what the user sees in
 * Telegram. We do not assert exact UTF-16 entity offsets here —
 * `emoji-utils.test.ts` covers the offset arithmetic in isolation —
 * but we do verify which keys produce custom_emoji entities and the
 * shape of the rendered text.
 */
import { describe, expect, it } from 'vitest';

import {
  buildPlansMessage,
  buildReferralMessage,
  buildSubscriptionCard,
  buildWelcomeMessage,
} from '../../../src/infrastructure/bot-message/message-builder.js';
import type {
  BotEmojiMap,
  Plan,
  Subscription,
} from '../../../src/infrastructure/bot-config/types.js';

const ACTIVE_SUB: Subscription = {
  id: 1,
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: 100,
  deviceLimit: 5,
  expireAt: '2026-12-31T00:00:00.000Z',
  url: 'https://example.com/sub/1',
  plan: { id: 1, name: 'Premium', type: 'STANDARD' },
};

describe('buildWelcomeMessage', () => {
  it('substitutes {{firstName}} into the welcome template', () => {
    const out = buildWelcomeMessage({
      firstName: 'Аня',
      welcomeTemplate: 'Привет, {{firstName}}!',
      format: 'minimal',
    });
    expect(out.text).toBe('Привет, Аня!');
    expect(out.entities).toEqual([]);
  });

  it('returns only the welcome part when no subscription is supplied', () => {
    const out = buildWelcomeMessage({
      firstName: 'A',
      welcomeTemplate: 'Hi {{firstName}}',
      format: 'full',
    });
    expect(out.text).toBe('Hi A');
  });

  it('returns only the welcome part when format is minimal even with a subscription', () => {
    const out = buildWelcomeMessage({
      firstName: 'A',
      subscription: ACTIVE_SUB,
      welcomeTemplate: 'Hi {{firstName}}',
      format: 'minimal',
    });
    expect(out.text).toBe('Hi A');
  });

  it('appends status + expiry + traffic + devices in full format', () => {
    const out = buildWelcomeMessage({
      firstName: 'A',
      subscription: ACTIVE_SUB,
      welcomeTemplate: 'Hi {{firstName}}',
      format: 'full',
    });
    expect(out.text).toContain('Hi A');
    expect(out.text).toContain('Подписка: ACTIVE');
    expect(out.text).toContain('📅 До:');
    expect(out.text).toContain('Трафик: 100 GB');
    expect(out.text).toContain('Устройства: 5');
  });

  it('renders compact format with only the status line', () => {
    const out = buildWelcomeMessage({
      firstName: 'A',
      subscription: ACTIVE_SUB,
      welcomeTemplate: 'Hi {{firstName}}',
      format: 'compact',
    });
    expect(out.text).toContain('Hi A');
    expect(out.text).toContain('Подписка: ACTIVE');
    expect(out.text).not.toContain('📅 До:');
    expect(out.text).not.toContain('Трафик:');
  });

  it('emits a custom_emoji entity for the welcome placeholder when configured', () => {
    const botEmojis: BotEmojiMap = {
      CARD: { unicode: '💳', tgEmojiId: '5111' },
    };
    const out = buildWelcomeMessage({
      firstName: 'A',
      welcomeTemplate: '{{CARD}} Hi',
      format: 'minimal',
      botEmojis,
    });
    expect(out.entities).toContainEqual(
      expect.objectContaining({ type: 'custom_emoji', custom_emoji_id: '5111' }),
    );
  });
});

describe('buildSubscriptionCard', () => {
  it('renders header + status + plan + expiry + traffic + devices', () => {
    const out = buildSubscriptionCard({ subscription: ACTIVE_SUB });
    expect(out.text).toContain('Подписка');
    expect(out.text).toContain('Статус: ACTIVE');
    expect(out.text).toContain('📋 Тариф: Premium');
    expect(out.text).toContain('Истекает:');
    expect(out.text).toContain('Трафик: 100 GB');
    expect(out.text).toContain('Устройства: 5');
  });

  it('inserts the trial badge when subscription.isTrial is true', () => {
    const out = buildSubscriptionCard({
      subscription: { ...ACTIVE_SUB, isTrial: true },
    });
    expect(out.text).toContain('Пробный период');
  });

  it('omits plan name when plan is null', () => {
    const out = buildSubscriptionCard({
      subscription: { ...ACTIVE_SUB, plan: null },
    });
    expect(out.text).not.toContain('📋 Тариф');
  });

  it('renders unlimited traffic + devices when limits are null', () => {
    const out = buildSubscriptionCard({
      subscription: { ...ACTIVE_SUB, trafficLimit: null, deviceLimit: null },
    });
    expect(out.text).toContain('Трафик: Безлимит');
    expect(out.text).toContain('Устройства: Безлимит');
  });

  it('emits a custom_emoji entity for STATUS_ACTIVE when configured', () => {
    const botEmojis: BotEmojiMap = {
      STATUS_ACTIVE: { unicode: '🟢', tgEmojiId: '5200' },
    };
    const out = buildSubscriptionCard({ subscription: ACTIVE_SUB, botEmojis });
    expect(out.entities).toContainEqual(
      expect.objectContaining({ type: 'custom_emoji', custom_emoji_id: '5200' }),
    );
  });

  it('falls back to STATUS_DISABLED for an unknown status', () => {
    const out = buildSubscriptionCard({
      subscription: { ...ACTIVE_SUB, status: 'EXPIRED' },
    });
    expect(out.text).toContain('Статус: EXPIRED');
  });
});

describe('buildPlansMessage', () => {
  const PLAN_A: Plan = {
    id: 1,
    name: 'Premium',
    trafficLimit: 100,
    deviceLimit: 5,
    durations: [
      { days: 30, prices: [{ currency: 'USD', price: 10 }] },
      { days: 90, prices: [{ currency: 'USD', price: 25 }] },
    ],
  };
  const PLAN_B: Plan = {
    id: 2,
    name: 'Lite',
    trafficLimit: null,
    deviceLimit: null,
    durations: [],
  };

  it('renders one section per plan with its name + traffic/devices line', () => {
    const out = buildPlansMessage({ plans: [PLAN_A, PLAN_B] });
    expect(out.text).toContain('Premium');
    expect(out.text).toContain('Lite');
    expect(out.text).toContain('Трафик: 100 GB');
    expect(out.text).toContain('Устройств: 5');
  });

  it('renders one duration line per duration (using the first price)', () => {
    const out = buildPlansMessage({ plans: [PLAN_A] });
    expect(out.text).toContain('30 дн. — 10 USD');
    expect(out.text).toContain('90 дн. — 25 USD');
  });

  it('handles plans with empty durations gracefully', () => {
    const out = buildPlansMessage({ plans: [PLAN_B] });
    expect(out.text).toContain('Lite');
    expect(out.text).toContain('Трафик: Безлимит');
    expect(out.text).not.toContain('дн. —');
  });

  it('renders an empty list as just the header', () => {
    const out = buildPlansMessage({ plans: [] });
    expect(out.text).toContain('Доступные тарифы');
  });
});

describe('buildReferralMessage', () => {
  it('renders header + stats + invite link', () => {
    const out = buildReferralMessage({
      totalReferrals: 5,
      qualifiedReferrals: 2,
      inviteLink: 'https://t.me/bot?start=abc',
    });
    expect(out.text).toContain('Реферальная программа');
    expect(out.text).toContain('Приглашено: 5');
    expect(out.text).toContain('Квалифицировано: 2');
    expect(out.text).toContain('https://t.me/bot?start=abc');
  });

  it('attaches a url entity covering the invite link', () => {
    const link = 'https://t.me/bot?start=abc';
    const out = buildReferralMessage({
      totalReferrals: 0,
      qualifiedReferrals: 0,
      inviteLink: link,
    });
    const urlEntities = out.entities.filter(
      (e) => (e as { type: string }).type === 'url',
    );
    expect(urlEntities).toHaveLength(1);
    // The link sits at the end of the message; its length matches the link's UTF-16 length.
    // ASCII URL → 1 unit per char.
    expect((urlEntities[0] as { length: number }).length).toBe(link.length);
  });

  it('includes a custom_emoji entity for the REFERRALS header when configured', () => {
    const botEmojis: BotEmojiMap = {
      REFERRALS: { unicode: '👥', tgEmojiId: '5300' },
    };
    const out = buildReferralMessage({
      totalReferrals: 0,
      qualifiedReferrals: 0,
      inviteLink: 'https://t.me/bot',
      botEmojis,
    });
    expect(out.entities).toContainEqual(
      expect.objectContaining({ type: 'custom_emoji', custom_emoji_id: '5300' }),
    );
  });
});
