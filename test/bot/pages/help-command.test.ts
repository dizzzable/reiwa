/**
 * `/help` command page specs.
 *
 * STEALTHNET rewrite: `/help` no longer prints an inline command list
 * (Telegram surfaces it via setMyCommands). It replies with
 * `support.title` + a contact-support button, or `support.not_configured`
 * when no handle is set. This is a command (not a callback), so it uses
 * `ctx.reply` directly.
 */
import { describe, expect, it } from 'vitest';

import { registerHelpCommandPage } from '../../../src/bot/pages/help.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerHelpCommandPage', () => {
  it('registers a /help command handler', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    expect(bot.commandHandlers.has('help')).toBe(true);
  });

  it('replies with support.not_configured when no support handle is set', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toBe('ru:support.not_configured');
  });

  it('replies with support.title + a contact-support URL button for a non-numeric handle', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '@rezeis_support' },
      },
    });
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0];
    expect(text).toBe('ru:support.title');
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    expect(kb.inline_keyboard[0][0].url).toContain('https://t.me/rezeis_support');
  });

  it('renders in the user persisted locale (en)', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ initialUserId: 7, initialLocale: 'en' });
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    const ctx = buildFakeCtx({ from: { id: 7 } });
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toBe('en:support.not_configured');
  });
});
