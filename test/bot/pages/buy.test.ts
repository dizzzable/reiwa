/**
 * Buy callback specs.
 */
import { describe, expect, it } from 'vitest';

import { registerBuyPage } from '../../../src/bot/pages/buy.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerBuyPage', () => {
  it('registers a single callback handler for the "buy" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerBuyPage(bot as unknown as Parameters<typeof registerBuyPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('buy');
  });

  it('replies with the open-app prompt + web_app keyboard when miniAppUrl is set', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ miniAppUrl: 'https://reiwa.example' });
    registerBuyPage(bot as unknown as Parameters<typeof registerBuyPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0];
    expect(text).toBe('ru:plans.open_app');
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> } }).reply_markup;
    expect(kb.inline_keyboard[0][0].web_app?.url).toBe('https://reiwa.example/plans');
  });

  it('replies with plans.use_command when Mini App is disabled', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      miniAppUrl: 'https://reiwa.example',
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, miniAppEnabled: false },
      },
    });
    registerBuyPage(bot as unknown as Parameters<typeof registerBuyPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:plans.use_command');
  });

  it('replies with plans.use_command when miniAppUrl is null', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ miniAppUrl: null });
    registerBuyPage(bot as unknown as Parameters<typeof registerBuyPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:plans.use_command');
  });
});
