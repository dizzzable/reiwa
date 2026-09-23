/**
 * `screen:<shortId>` — the universal handler for the operator's own screens.
 *
 * Two things pinned here:
 *
 *   • A button whose screen was deleted, or not yet published, answers with
 *     `screen.not_found`. That text is a translator key «Тексты бота» can
 *     override, with the panel's emoji picker in the field, and it was the one
 *     text on this page sent without a renderer — an operator's `:slug:` reached
 *     the user as `:fire:`.
 *   • The three built-in screens (help, rules, invite) are reachable this way
 *     too — a NAVIGATE edge onto one of them in «Карта бота», a menu button set
 *     to «Экран бота», a notification button — and rendered as a plain screen
 *     they showed `{{rulesLink}}`, `{{supportHandle}}` and `{{link}}` raw and
 *     none of their own buttons. They are handed to their built-in handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDynamicScreenPage } from '../../../src/bot/pages/dynamic-screen.js';
import { setLegalDocumentsCache } from '../../../src/infrastructure/admin-client/legal-documents-cache.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig, BotScreen } from '../../../src/infrastructure/bot-config/types.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  buildFakeCtx,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

describe('registerDynamicScreenPage — a screen that is not there', () => {
  it('says so with the operator text, emoji tokens resolved', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ config: { ...operatorEmojiConfig(), screens: [] } });
    registerDynamicScreenPage(bot as unknown as Parameters<typeof registerDynamicScreenPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['screen.not_found']),
    });
    const ctx = { ...buildFakeCtx(), callbackQuery: { data: 'screen:gone' } };

    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const [text, opts] = ctx.editMessageText.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });
});

describe('registerDynamicScreenPage — a built-in screen reached by its shortId', () => {
  beforeEach(() => {
    // Process-wide singletons: a previous case's fake client must not answer this one.
    setPolicyCache(null);
    setLegalDocumentsCache(null);
  });

  function screen(shortId: string, name: string, textRu: string): BotScreen {
    return {
      id: `screen-${shortId}`,
      shortId,
      name,
      textRu,
      textEn: '',
      parseMode: 'plain',
      mediaType: null,
      mediaFileId: null,
      mediaUrl: null,
      isRoot: false,
      buttons: [],
    };
  }

  type Button = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };

  async function open(
    shortId: string,
    config: BotConfig,
    admin: Record<string, unknown> | null = null,
  ): Promise<{ text: string; buttons: Button[] }> {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config,
      publicWebUrl: 'https://reiwa.example',
      ...(admin !== null ? { adminOverrides: admin } : {}),
    });
    registerDynamicScreenPage(bot as unknown as Parameters<typeof registerDynamicScreenPage>[0], deps);
    const ctx = { ...buildFakeCtx({ from: { id: 5 } }), callbackQuery: { data: `screen:${shortId}` } };
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: Button[][] } },
    ];
    return { text, buttons: opts.reply_markup.inline_keyboard.flat() };
  }

  it('rules: the link filled in, and the button that opens it', async () => {
    const admin = {
      system: { getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: 'https://rules.example/legal' }) },
    };
    const { text, buttons } = await open(
      'r1',
      // The name is matched as the built-in lookup matches it: case aside.
      { ...DEFAULT_BOT_CONFIG, screens: [screen('r1', 'Rules', 'Правила: {{rulesLink}}')] },
      admin,
    );
    expect(text).toBe('Правила: https://rules.example/legal');
    expect(buttons.map((b) => b.url ?? b.callback_data)).toEqual(['https://rules.example/legal', 'menu:main']);
  });

  it('help: the support handle filled in, and the button that writes to support', async () => {
    const { text, buttons } = await open('h1', {
      ...DEFAULT_BOT_CONFIG,
      visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '@rezeis_support' },
      screens: [screen('h1', 'help', 'Пишите {{supportHandle}}')],
    });
    expect(text).toBe('Пишите @rezeis_support');
    expect(buttons.some((b) => b.url?.startsWith('https://t.me/rezeis_support?text='))).toBe(true);
    expect(buttons.at(-1)?.callback_data).toBe('menu:main');
  });

  it('invite: the referral link filled in, and the button that shares it', async () => {
    const admin = {
      referrals: { getSummary: vi.fn().mockResolvedValue({ referralCode: 'reiwa-id-1' }) },
      partner: {},
    };
    const { text, buttons } = await open(
      'i1',
      { ...DEFAULT_BOT_CONFIG, screens: [screen('i1', 'invite', 'Ссылка: {{link}}')] },
      admin,
    );
    expect(text).toContain('Ссылка: https://t.me/reiwa_test_bot?start=ref_reiwa-id-1');
    expect(buttons.some((b) => b.url?.startsWith('https://t.me/share/url?'))).toBe(true);
  });

  it('an operator screen of any other name is still rendered as it was written', async () => {
    const { text, buttons } = await open('o1', {
      ...DEFAULT_BOT_CONFIG,
      screens: [screen('o1', 'promo', 'Акция {{rulesLink}}')],
    });
    expect(text).toBe('Акция {{rulesLink}}');
    expect(buttons.map((b) => b.callback_data)).toEqual(['menu:main']);
  });

  // The panel's notification editor takes callback data as free text, and
  // «Карта бота» has drawn a bare shortId as a way to open a screen since June.
  // The bot answered `screen:<shortId>` only: such a button spun and did nothing.
  describe('a bare shortId as the whole callback data', () => {
    type Next = () => Promise<void>;
    function bareHandler(bot: ReturnType<typeof buildFakeBot>) {
      return bot.updateHandlers.get('callback_query:data') as unknown as
        | ((ctx: BotContext, next: Next) => Promise<void>)
        | undefined;
    }

    async function press(data: string, config: BotConfig, admin: Record<string, unknown> | null = null) {
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        config,
        publicWebUrl: 'https://reiwa.example',
        ...(admin !== null ? { adminOverrides: admin } : {}),
      });
      registerDynamicScreenPage(bot as unknown as Parameters<typeof registerDynamicScreenPage>[0], deps);
      const ctx = { ...buildFakeCtx({ from: { id: 5 } }), callbackQuery: { data } };
      const next = vi.fn(async () => undefined);
      const handler = bareHandler(bot);
      expect(handler).toBeDefined();
      await handler!(ctx as unknown as BotContext, next);
      return { ctx, next };
    }

    it('opens that screen exactly as `screen:<shortId>` does', async () => {
      const config = { ...DEFAULT_BOT_CONFIG, screens: [screen('promo42x', 'promo', 'Акция недели')] };
      const bare = await press('promo42x', config);
      const prefixed = await open('promo42x', config);
      expect(bare.next).not.toHaveBeenCalled();
      expect(bare.ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      const [text, opts] = bare.ctx.editMessageText.mock.calls[0] as [string, { reply_markup: unknown }];
      expect(text).toBe(prefixed.text);
      expect(JSON.stringify(opts.reply_markup)).toBe(
        JSON.stringify({ inline_keyboard: [prefixed.buttons] }),
      );
    });

    it('hands a built-in screen to its handler, as `screen:<shortId>` does', async () => {
      const admin = {
        system: { getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: 'https://rules.example/legal' }) },
      };
      const { ctx } = await press(
        'rulz1234',
        { ...DEFAULT_BOT_CONFIG, screens: [screen('rulz1234', 'rules', 'Правила: {{rulesLink}}')] },
        admin,
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(ctx.editMessageText.mock.calls[0][0]).toBe('Правила: https://rules.example/legal');
    });

    it('passes data that names no screen on, answering nothing — as before', async () => {
      const { ctx, next } = await press('nonsense', { ...DEFAULT_BOT_CONFIG, screens: [screen('promo42x', 'promo', 'Акция')] });
      expect(next).toHaveBeenCalledTimes(1);
      expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    // Most data that reaches this handler is a dead button — an old message's,
    // a menu id no page answers — and before bare shortIds nothing waited on it.
    // Updates are handled one at a time, and a config read past the cache's TTL
    // waits for the panel: up to the transport's ten seconds when it hangs, for
    // this press and every update queued behind it.
    describe('while the config read hangs', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      function registerWith(getConfig: () => Promise<BotConfig>, config: BotConfig, held: BotConfig | null = null) {
        const bot = buildFakeBot();
        const { deps } = buildDeps({ config, publicWebUrl: 'https://reiwa.example' });
        registerDynamicScreenPage(bot as unknown as Parameters<typeof registerDynamicScreenPage>[0], {
          ...deps,
          getConfig,
          peekConfig: () => held,
        });
        return bareHandler(bot)!;
      }
      const hangs = (): Promise<BotConfig> => new Promise<BotConfig>(() => undefined);

      it('passes the press on within a quarter second, answering nothing', async () => {
        vi.useFakeTimers();
        const handler = registerWith(hangs, DEFAULT_BOT_CONFIG);
        const ctx = { ...buildFakeCtx({ from: { id: 5 } }), callbackQuery: { data: 'subscription' } };
        const next = vi.fn(async () => undefined);

        void handler(ctx as unknown as BotContext, next);
        await vi.advanceTimersByTimeAsync(250);

        expect(next).toHaveBeenCalledTimes(1);
        expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
      });

      it('decides on the config the bot holds, and opens the screen from it', async () => {
        vi.useFakeTimers();
        const config = { ...DEFAULT_BOT_CONFIG, screens: [screen('promo42x', 'promo', 'Акция недели')] };
        const handler = registerWith(hangs, config, config);

        const ctx = { ...buildFakeCtx({ from: { id: 5 } }), callbackQuery: { data: 'promo42x' } };
        const next = vi.fn(async () => undefined);
        let settled = false;
        const done = handler(ctx as unknown as BotContext, next).then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(250);

        expect(settled).toBe(true);
        await done;
        expect(next).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(ctx.editMessageText.mock.calls[0]?.[0]).toBe('Акция недели');
      });
    });
  });

  // Reached by its shortId, a built-in screen used to cost ONE config read: the
  // one that found it. The hand-off to its built-in handler must not add a
  // second, which a hung panel makes wait out the transport's ten seconds —
  // holding every update queued behind (they are handled one at a time).
  describe('a built-in screen reached by its shortId reads the config once', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const BUILT_INS = [
      ['help', 'Пишите {{supportHandle}}'],
      ['rules', 'Правила {{rulesLink}}'],
      ['invite', 'Ссылка: {{link}}'],
    ] as const;

    /** The page on a panel that answers the first config read only. */
    function registerAnsweringOnce(config: BotConfig) {
      const bot = buildFakeBot();
      const { deps } = buildDeps({ config, publicWebUrl: 'https://reiwa.example' });
      const reads = { count: 0 };
      registerDynamicScreenPage(bot as unknown as Parameters<typeof registerDynamicScreenPage>[0], {
        ...deps,
        getConfig: () => {
          reads.count += 1;
          return reads.count === 1 ? Promise.resolve(config) : new Promise<BotConfig>(() => undefined);
        },
      });
      return { bot, reads };
    }

    async function settlesWithin(ms: number, run: Promise<void>): Promise<boolean> {
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(ms);
      return settled;
    }

    it.each(BUILT_INS)('`screen:<shortId>` onto the %s screen', async (name, text) => {
      vi.useFakeTimers();
      const { bot, reads } = registerAnsweringOnce({ ...DEFAULT_BOT_CONFIG, screens: [screen('b1', name, text)] });
      const ctx = { ...buildFakeCtx({ from: { id: 5 } }), callbackQuery: { data: 'screen:b1' } };

      expect(await settlesWithin(0, bot.callbackHandlers[0].handler(ctx as unknown as BotContext))).toBe(true);
      expect(reads.count).toBe(1);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(ctx.editMessageText.mock.calls.length + ctx.reply.mock.calls.length).toBe(1);
    });

    it.each(BUILT_INS)('a bare shortId of the %s screen, the panel hanging', async (name, text) => {
      vi.useFakeTimers();
      // The panel answers no read; the bot holds the config the screen is in.
      const config = { ...DEFAULT_BOT_CONFIG, screens: [screen('b1', name, text)] };
      const bot = buildFakeBot();
      const { deps } = buildDeps({ config, publicWebUrl: 'https://reiwa.example' });
      const reads = { count: 0 };
      registerDynamicScreenPage(bot as unknown as Parameters<typeof registerDynamicScreenPage>[0], {
        ...deps,
        getConfig: () => {
          reads.count += 1;
          return new Promise<BotConfig>(() => undefined);
        },
        peekConfig: () => config,
      });
      const handler = bot.updateHandlers.get('callback_query:data') as unknown as (
        ctx: BotContext,
        next: () => Promise<void>,
      ) => Promise<void>;

      const ctx = { ...buildFakeCtx({ from: { id: 5 } }), callbackQuery: { data: 'b1' } };
      expect(await settlesWithin(250, handler(ctx as unknown as BotContext, vi.fn(async () => undefined)))).toBe(true);
      expect(reads.count).toBe(1);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(ctx.editMessageText.mock.calls.length + ctx.reply.mock.calls.length).toBe(1);
    });
  });

  // An operator names a screen freely, and an object's prototype has names of
  // its own: `constructor` must be an operator screen, not a built-in.
  it('a screen named like an object’s own member is an operator screen too', async () => {
    const { text } = await open('c1', {
      ...DEFAULT_BOT_CONFIG,
      screens: [screen('c1', 'constructor', 'Просто экран')],
    });
    expect(text).toBe('Просто экран');
  });
});
