/**
 * `help` callback page specs.
 *
 * STEALTHNET rewrite: the help/support sub-menu renders `support.title`
 * in place via `editOrReply` (-> `ctx.editMessageText`) with a
 * contact-support URL button, instead of the old inline command list.
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

  it('renders support.not_configured when no support handle is set', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCallbackPage(
      bot as unknown as Parameters<typeof registerHelpCallbackPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const reply = ctx.editMessageText.mock.calls[0][0] as string;
    // DEFAULT_BOT_CONFIG has no support username and no env fallback set,
    // so we get the not-configured fallback copy (no support button).
    expect(reply).toBe('ru:support.not_configured');
  });

  it('renders support.title + a contact-support URL button for a non-numeric handle', async () => {
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
    const [text, opts] = ctx.editMessageText.mock.calls[0];
    expect(text).toBe('ru:support.title');
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    expect(kb.inline_keyboard[0][0].url).toContain('https://t.me/rezeis_support');
  });

  it('renders the in-app Support page button before the contact + back buttons when a Mini App URL is configured', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      miniAppUrl: 'https://app.example.com',
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
    const [, opts] = ctx.editMessageText.mock.calls[0];
    const kb = (
      opts as {
        reply_markup: {
          inline_keyboard: Array<Array<{ url?: string; web_app?: { url: string }; callback_data?: string }>>
        }
      }
    ).reply_markup;
    // #1 in-app Support page (web_app → /support), #2 contact URL, #3 back to menu.
    expect(kb.inline_keyboard[0][0].web_app?.url).toBe('https://app.example.com/support');
    const urlBtn = kb.inline_keyboard.flat().find((b) => typeof b.url === 'string');
    expect(urlBtn?.url).toContain('https://t.me/rezeis_support');
    const backBtn = kb.inline_keyboard.flat().find((b) => b.callback_data === 'menu:main');
    expect(backBtn).toBeDefined();
  });

  it('renders in the user persisted locale (en)', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      initialUserId: 7,
      initialLocale: 'en',
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '@rezeis_support' },
      },
    });
    registerHelpCallbackPage(
      bot as unknown as Parameters<typeof registerHelpCallbackPage>[0],
      deps,
    );
    const ctx = buildFakeCtx({ from: { id: 7 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const reply = ctx.editMessageText.mock.calls[0][0] as string;
    expect(reply).toBe('en:support.title');
  });
});
