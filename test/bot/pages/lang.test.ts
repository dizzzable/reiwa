/**
 * /lang page specs.
 *
 * Pinned behaviours:
 *   - `/lang` opens the locale picker keyboard
 *   - `lang:<locale>` callback persists the locale in the cache
 *   - the admin client is called fire-and-forget (failure is swallowed)
 *   - unsupported locale tags coerce to the RU default
 *   - the confirmation message renders in the newly chosen locale
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerLangPage } from '../../../src/bot/pages/lang.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  buildFakeCtx,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

function withAdminSpy(): {
  adminClient: PageDeps['adminClient'];
  calls: string[];
  failNext: { value: boolean };
} {
  const calls: string[] = [];
  const failNext = { value: false };
  const updateLanguage = vi.fn(
    async (identity: { telegramId?: string; userId?: string }, lang: string) => {
      if (failNext.value) {
        failNext.value = false;
        throw new Error('boom');
      }
      calls.push(`${identity.telegramId ?? identity.userId ?? ''}:${lang}`);
    },
  );
  return {
    adminClient: { user: { updateLanguage } } as unknown as PageDeps['adminClient'],
    calls,
    failNext,
  };
}

describe('registerLangPage', () => {
  it('registers the /lang command and the lang:* callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    expect(bot.commandHandlers.has('lang')).toBe(true);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBeInstanceOf(RegExp);
  });

  it('/lang renders the picker in the user persisted locale', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ initialUserId: 7, initialLocale: 'en' });
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const ctx = buildFakeCtx({ from: { id: 7 } });
    await bot.commandHandlers.get('lang')!(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toBe('en:lang.choose');
  });

  it('lang:* callback updates the cache, calls admin, confirms in new locale', async () => {
    const spy = withAdminSpy();
    const bot = buildFakeBot();
    const { deps, userLocale } = buildDeps({
      adminOverrides: spy.adminClient as unknown as Record<string, unknown>,
    });
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const handler = bot.callbackHandlers[0].handler;
    const ctx = buildFakeCtx({
      from: { id: 99 },
      match: ['lang:en', 'en'] as unknown as RegExpMatchArray,
    });
    await handler(ctx as unknown as BotContext);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(userLocale.getSync(99)).toBe('en');
    expect(spy.calls).toEqual(['99:en']);
    // `{}`: no emoji entities in this text, so none are sent.
    expect(ctx.reply).toHaveBeenCalledWith('en:lang.changed(lang=en:lang.name.en)', {});
  });

  it('coerces an unsupported locale tag to the RU default', async () => {
    const bot = buildFakeBot();
    const { deps, userLocale } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const handler = bot.callbackHandlers[0].handler;
    const ctx = buildFakeCtx({
      from: { id: 1 },
      match: ['lang:fr', 'fr'] as unknown as RegExpMatchArray,
    });
    await handler(ctx as unknown as BotContext);
    expect(userLocale.getSync(1)).toBe('ru');
  });

  it('swallows admin updateUserLanguage failures (fire-and-forget)', async () => {
    const spy = withAdminSpy();
    spy.failNext.value = true;
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: spy.adminClient as unknown as Record<string, unknown>,
    });
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const handler = bot.callbackHandlers[0].handler;
    const ctx = buildFakeCtx({
      from: { id: 7 },
      match: ['lang:en', 'en'] as unknown as RegExpMatchArray,
    });
    await expect(handler(ctx as unknown as BotContext)).resolves.toBeUndefined();
  });

  it('skips the admin call when adminClient is null', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const handler = bot.callbackHandlers[0].handler;
    const ctx = buildFakeCtx({
      from: { id: 1 },
      match: ['lang:ru', 'ru'] as unknown as RegExpMatchArray,
    });
    await expect(handler(ctx as unknown as BotContext)).resolves.toBeUndefined();
  });
});

// Both messages are translator keys «Тексты бота» can override, with the
// panel's emoji picker in the field — the picker's two buttons already resolved
// their tokens, the text above them did not. Sent raw, the user read `:fire:`.
describe('/lang answers with the operator text, emoji tokens resolved', () => {
  it('the picker message', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ config: operatorEmojiConfig() });
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['lang.choose']),
    });
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('lang')!(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });

  it('the confirmation, with the language name in it', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ config: operatorEmojiConfig() });
    const translator = withOperatorText(
      withOperatorText(deps.translator, ['lang.changed'], ':fire: Язык: {{lang}} {{GIFT}}'),
      ['lang.name.en'],
      'English',
    );
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], { ...deps, translator });
    const ctx = buildFakeCtx({ match: ['lang:en', 'en'] as unknown as RegExpMatchArray });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe('🔥 Язык: English 🎁');
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });
});

// The confirmation's emoji are rendered with the config — a read this reply did
// not make before its tokens were resolved. Updates are handled one at a time,
// and a config read past the cache's TTL waits for the panel: up to the
// transport's ten seconds when it hangs, for this switch and every update
// queued behind it.
describe('the language confirmation while the config read hangs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const hangs = (): Promise<BotConfig> => new Promise<BotConfig>(() => undefined);

  it('goes out within a second, rendered without a config', async () => {
    vi.useFakeTimers();
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], { ...deps, getConfig: hangs });
    const ctx = buildFakeCtx({ from: { id: 99 }, match: ['lang:en', 'en'] as unknown as RegExpMatchArray });

    void bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('en:lang.changed(lang=en:lang.name.en)', {});
  });

  it('renders it with the config the bot holds', async () => {
    vi.useFakeTimers();
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['lang.changed']),
      getConfig: hangs,
      peekConfig: () => operatorEmojiConfig(),
    });
    const ctx = buildFakeCtx({ match: ['lang:ru', 'ru'] as unknown as RegExpMatchArray });
    void bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith(OPERATOR_TEXT_GLYPHS, { entities: [FIRE_ENTITY] });
  });
});
