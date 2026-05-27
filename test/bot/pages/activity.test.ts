/**
 * Activity callback specs.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerActivityPage } from '../../../src/bot/pages/activity.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerActivityPage', () => {
  it('registers a single callback handler for the "activity" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerActivityPage(bot as unknown as Parameters<typeof registerActivityPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('activity');
  });

  it('replies with activity.empty when admin returns no transactions', async () => {
    const adminClient = ({
      activity: { getTransactions: vi.fn().mockResolvedValue({ transactions: [] }) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerActivityPage(bot as unknown as Parameters<typeof registerActivityPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:activity.empty');
  });

  it('renders one bullet per transaction with gateway/amount/status', async () => {
    const adminClient = ({
      activity: {
        getTransactions: vi.fn().mockResolvedValue({
          transactions: [
            {
              gatewayType: 'YOOMONEY',
              amount: '500.00',
              currency: 'RUB',
              status: 'COMPLETED',
            },
            {
              gateway: 'CRYPTOMUS',
              pricing: { finalPrice: '5.00', currency: 'USDT' },
              status: 'PENDING',
            },
          ],
        }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerActivityPage(bot as unknown as Parameters<typeof registerActivityPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('ru:activity.header');
    expect(text).toContain('• YOOMONEY — 500.00 RUB — COMPLETED');
    expect(text).toContain('• CRYPTOMUS — 5.00 USDT — PENDING');
  });

  it('falls back to activity.error when admin throws', async () => {
    const adminClient = ({
      get activity() {
        throw new Error('boom');
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerActivityPage(bot as unknown as Parameters<typeof registerActivityPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:activity.error');
  });
});
