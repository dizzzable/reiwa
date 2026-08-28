import { describe, expect, it } from 'vitest';

import { registerPaySupportPage } from '../../../src/bot/pages/paysupport.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

/**
 * `/paysupport`.
 *
 * Telegram expects this command from a bot that takes payments, and it has been
 * in our `/` autocomplete with no handler at all — tapping it did nothing,
 * because the AI-support catch-all drops anything starting with `/`.
 *
 * The interesting case is the one with NO support handle configured. A screen
 * that says "write to support" above a keyboard with no way to write to support
 * is worse than one that admits the contact is missing, and it is the state of
 * every install that has not filled the handle in — so it gets its own copy and
 * its own assertion here rather than being left to the happy path.
 */

function configWithSupport(username: string): BotConfig {
  return {
    ...DEFAULT_BOT_CONFIG,
    visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: username },
  };
}

function run(deps: PageDeps) {
  const bot = buildFakeBot();
  registerPaySupportPage(bot as unknown as Parameters<typeof registerPaySupportPage>[0], deps);
  const handler = bot.commandHandlers.get('paysupport');
  if (handler === undefined) throw new Error('paysupport handler was not registered');
  const ctx = buildFakeCtx();
  return { ctx, invoke: () => handler(ctx as unknown as BotContext) };
}

function keyboardOf(ctx: ReturnType<typeof buildFakeCtx>): Array<Array<{ text?: string; url?: string; callback_data?: string }>> {
  const [, opts] = ctx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: Array<Array<{ text?: string; url?: string; callback_data?: string }>> } }];
  return opts.reply_markup.inline_keyboard;
}

describe('registerPaySupportPage', () => {
  it('offers a support chat prefilled with the payment subject', () => {
    const { deps } = buildDeps({ config: configWithSupport('@rezeis_help') });
    const { ctx, invoke } = run(deps);

    return invoke().then(() => {
      const [text] = ctx.reply.mock.calls[0] as [string];
      expect(text).toBe('ru:paysupport.body');

      const rows = keyboardOf(ctx);
      // The prefill is the point: support opens the chat already knowing this
      // is about a charge, which is the whole reason `/paysupport` is not an
      // alias of `/help`.
      expect(rows[0]?.[0]?.url).toBe(
        'https://t.me/rezeis_help?text=ru%3Apaysupport.prefill',
      );
      expect(rows[1]?.[0]?.callback_data).toBe('menu:main');
    });
  });

  it('falls back to the env handle when the panel has none', async () => {
    // The panel field is an override, not a requirement — `BOT_SUPPORT_USERNAME`
    // is what a fresh deploy has, and the resolver has to keep honouring it.
    const { deps } = buildDeps();
    const { ctx, invoke } = run({ ...deps, envSupportUsername: 'env_help' });
    await invoke();

    expect(keyboardOf(ctx)[0]?.[0]?.url).toBe(
      'https://t.me/env_help?text=ru%3Apaysupport.prefill',
    );
  });

  it('says the contact is missing instead of promising one', async () => {
    const { deps } = buildDeps();
    const { ctx, invoke } = run(deps);
    await invoke();

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toBe('ru:paysupport.unavailable');
    // And no dead button above that copy — only the way back.
    const rows = keyboardOf(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]?.callback_data).toBe('menu:main');
  });

  it('refuses a numeric handle rather than building a broken link', async () => {
    // `t.me/<digits>` is not a deep-link. An operator who pasted a chat id gets
    // the no-contact screen, which is honest, instead of a button that 404s.
    const { deps } = buildDeps({ config: configWithSupport('123456789') });
    const { ctx, invoke } = run(deps);
    await invoke();

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toBe('ru:paysupport.unavailable');
    expect(keyboardOf(ctx)).toHaveLength(1);
  });

  it('sends a fresh message rather than editing one', async () => {
    // A command has no previous screen to replace, and `editMessageText` would
    // target the user's own `/paysupport` message — which Telegram refuses.
    const { deps } = buildDeps({ config: configWithSupport('@rezeis_help') });
    const { ctx, invoke } = run(deps);
    await invoke();

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.editMessageCaption).not.toHaveBeenCalled();
  });
});
