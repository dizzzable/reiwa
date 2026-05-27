/**
 * `help` callback page specs.
 */
import { describe, expect, it } from 'vitest';

import { registerHelpCallbackPage } from '../../../src/bot/pages/help-callback.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerHelpCallbackPage', () => {
  it('registers a single callback handler for the "help" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCallbackPage(
      bot as unknown as Parameters<typeof registerHelpCallbackPage>[0],
      deps,
    );
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('help');
  });

  it('renders help.title + help.start + help.help when no support username is set', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCallbackPage(
      bot as unknown as Parameters<typeof registerHelpCallbackPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('ru:help.title');
    expect(reply).toContain('ru:help.start');
    expect(reply).toContain('ru:help.help');
    expect(reply).not.toContain('contact_support');
  });

  it('appends help.contact_support with the operator support username (without @)', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '@rezeis_support' },
      },
    });
    registerHelpCallbackPage(
      bot as unknown as Parameters<typeof registerHelpCallbackPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('ru:help.contact_support(username=rezeis_support)');
  });

  it('renders in the user persisted locale (en)', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ initialUserId: 7, initialLocale: 'en' });
    registerHelpCallbackPage(
      bot as unknown as Parameters<typeof registerHelpCallbackPage>[0],
      deps,
    );
    const ctx = buildFakeCtx({ from: { id: 7 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('en:help.title');
  });
});
