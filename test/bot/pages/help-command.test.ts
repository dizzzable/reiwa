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
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  buildFakeCtx,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

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

  // `help.contact_prefill` is on the help screen of «Карта бота», whose picker
  // inserts `:slug:` pack emoji and `{{KEY}}` placeholders. The text travels as
  // the link's `?text=`, which carries no entities: unresolved, support read the
  // token itself.
  it('pre-fills the support chat with the operator text, emoji tokens resolved', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '@rezeis_support' },
        customEmojis: { fire: { id: '5368324170671202286', fallback: '🔥' } },
        botEmojiOwnerHasPremium: true,
      },
    });
    const translator = {
      ...deps.translator,
      t: (key: string, lang: string, vars?: Record<string, string | number>) =>
        key === 'help.contact_prefill'
          ? ':fire: Здравствуйте! {{GIFT}}'
          : deps.translator.t(key, lang as never, vars),
    } as PageDeps['translator'];
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      { ...deps, translator },
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const [, opts] = ctx.reply.mock.calls[0];
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    const contact = kb.inline_keyboard.flat().find((b) => b.url?.startsWith('https://t.me/rezeis_support'));
    expect(contact?.url).toBeDefined();
    expect(new URL(contact!.url!).searchParams.get('text')).toBe('🔥 Здравствуйте! 🎁');
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

// `support.title`, `help.contact_support` and `support.not_configured` are on
// the help screen of «Карта бота», whose picker inserts `:slug:` pack emoji and
// `{{KEY}}` placeholders. The keyboard-button route to this screen resolved
// them; `/help` sent them raw, so the same text read `:fire:` on one door only.
describe('/help answers with the operator text, emoji tokens resolved', () => {
  async function helpWith(
    keys: readonly string[],
    supportUsername: string,
  ): Promise<{ text: string; entities: unknown }> {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: operatorEmojiConfig({
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername },
      }),
    });
    registerHelpCommandPage(bot as unknown as Parameters<typeof registerHelpCommandPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, keys),
    });
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    return { text, entities: opts.entities };
  }

  it('the support screen, beside the contact button', async () => {
    expect(await helpWith(['support.title'], '@rezeis_support')).toEqual({
      text: OPERATOR_TEXT_GLYPHS,
      entities: [FIRE_ENTITY],
    });
  });

  it('the support screen and the contact line, for a handle Telegram cannot link to', async () => {
    const { text, entities } = await helpWith(['support.title', 'help.contact_support'], '123456789');
    expect(text).toBe(`${OPERATOR_TEXT_GLYPHS}\n\n${OPERATOR_TEXT_GLYPHS}`);
    // The second line's entity starts after the first line and the blank one.
    const second = OPERATOR_TEXT_GLYPHS.length + 2;
    expect(entities).toEqual([FIRE_ENTITY, { ...FIRE_ENTITY, offset: second }]);
  });

  it('«support is not configured»', async () => {
    expect(await helpWith(['support.not_configured'], '')).toEqual({
      text: OPERATOR_TEXT_GLYPHS,
      entities: [FIRE_ENTITY],
    });
  });
});
