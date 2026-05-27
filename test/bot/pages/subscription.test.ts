/**
 * `/subscription` command + `subscription` callback page specs.
 *
 * Both surfaces share the same render path so each spec invokes one
 * to assert behaviour and a final spec confirms both handlers are
 * registered.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerSubscriptionPage } from '../../../src/bot/pages/subscription.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

const ACTIVE_SUB = {
  id: 1,
  status: 'ACTIVE' as const,
  isTrial: false,
  trafficLimit: 100,
  deviceLimit: 5,
  expireAt: '2026-12-31T00:00:00.000Z',
  url: 'https://example.com/sub/1',
  plan: { id: 1, name: 'Premium', type: 'STANDARD' },
};

describe('registerSubscriptionPage', () => {
  it('registers /subscription command + subscription callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerSubscriptionPage(
      bot as unknown as Parameters<typeof registerSubscriptionPage>[0],
      deps,
    );
    expect(bot.commandHandlers.has('subscription')).toBe(true);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('subscription');
  });

  it('replies with subscription.no_active when no admin client', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerSubscriptionPage(
      bot as unknown as Parameters<typeof registerSubscriptionPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('subscription')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:subscription.no_active');
  });

  it('replies with subscription.no_active when admin returns null', async () => {
    const adminClient = ({
      subscription: { getActive: vi.fn().mockResolvedValue(null) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerSubscriptionPage(
      bot as unknown as Parameters<typeof registerSubscriptionPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('subscription')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:subscription.no_active');
  });

  it('renders the subscription card when admin returns a subscription', async () => {
    const adminClient = ({
      subscription: { getActive: vi.fn().mockResolvedValue(ACTIVE_SUB) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerSubscriptionPage(
      bot as unknown as Parameters<typeof registerSubscriptionPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('subscription')!(ctx as unknown as BotContext);
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('Подписка');
    expect(text).toContain('Premium');
    expect(text).toContain('ACTIVE');
  });

  it('callback acks before rendering', async () => {
    const adminClient = ({
      subscription: { getActive: vi.fn().mockResolvedValue(ACTIVE_SUB) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerSubscriptionPage(
      bot as unknown as Parameters<typeof registerSubscriptionPage>[0],
      deps,
    );
    const handler = bot.callbackHandlers[0].handler;
    const ctx = buildFakeCtx();
    await handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it('falls back to subscription.error when an unexpected error escapes', async () => {
    const adminClient = ({
      get subscription() {
        throw new Error('explosion');
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerSubscriptionPage(
      bot as unknown as Parameters<typeof registerSubscriptionPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('subscription')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:subscription.error');
  });
});
