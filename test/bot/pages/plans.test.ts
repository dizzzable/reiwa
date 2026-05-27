/**
 * `/plans` command page specs.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerPlansPage } from '../../../src/bot/pages/plans.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerPlansPage', () => {
  it('registers a /plans command handler', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerPlansPage(bot as unknown as Parameters<typeof registerPlansPage>[0], deps);
    expect(bot.commandHandlers.has('plans')).toBe(true);
  });

  it('replies with plans.empty when no admin client', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerPlansPage(bot as unknown as Parameters<typeof registerPlansPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('plans')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:plans.empty');
  });

  it('replies with plans.empty when admin returns empty array', async () => {
    const adminClient = ({
      catalog: { getPublicPlans: vi.fn().mockResolvedValue([]) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerPlansPage(bot as unknown as Parameters<typeof registerPlansPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('plans')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:plans.empty');
  });

  it('renders the catalog message when plans are present', async () => {
    const adminClient = ({
      catalog: {
        getPublicPlans: vi.fn().mockResolvedValue([
          {
            id: 1,
            name: 'Premium',
            trafficLimit: 100,
            deviceLimit: 5,
            durations: [{ days: 30, prices: [{ currency: 'USD', price: 10 }] }],
          },
        ]),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerPlansPage(bot as unknown as Parameters<typeof registerPlansPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('plans')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('Premium');
    expect(text).toContain('30 дн. — 10 USD');
  });

  it('falls back to plans.error when an unexpected error escapes', async () => {
    const adminClient = ({
      get catalog() {
        throw new Error('explosion');
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerPlansPage(bot as unknown as Parameters<typeof registerPlansPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('plans')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:plans.error');
  });
});
