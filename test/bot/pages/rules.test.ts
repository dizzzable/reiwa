/**
 * `rules` callback page specs.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerRulesPage } from '../../../src/bot/pages/rules.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerRulesPage', () => {
  it('registers a single callback handler for the "rules" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('rules');
  });

  it('replies with rules.unavailable when no admin client is configured', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:rules.unavailable');
  });

  it('replies with rules.unavailable when policy.rulesLink is empty', async () => {
    const adminClient = ({
      system: { getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: '' }) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:rules.unavailable');
  });

  it('renders rules.intro with an inline url button when link is set', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: 'https://rules.example/legal' }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.reply.mock.calls[0];
    expect(text).toBe('ru:rules.intro');
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    expect(kb.inline_keyboard[0][0].url).toBe('https://rules.example/legal');
  });

  it('falls back to rules.unavailable when getPlatformPolicy throws', async () => {
    const adminClient = ({
      system: { getPlatformPolicy: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:rules.unavailable');
  });
});
