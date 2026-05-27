/**
 * /lang page specs.
 *
 * Test approach: register the page against a fake bot that records
 * which handlers it received, then invoke each handler with a fake
 * grammy `Context` to assert the user-visible side effects (replies,
 * locale-cache writes, admin client calls).
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
import type {
  BotContext,
  PageDeps,
  UserLocaleSyncCache,
} from '../../../src/bot/pages/types.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';

interface FakeBot {
  commandHandlers: Map<string, (ctx: BotContext) => Promise<void>>;
  callbackHandlers: Array<{
    matcher: string | RegExp;
    handler: (ctx: BotContext) => Promise<void>;
  }>;
  command(name: string, handler: (ctx: BotContext) => Promise<void>): void;
  callbackQuery(
    matcher: string | RegExp,
    handler: (ctx: BotContext) => Promise<void>,
  ): void;
}

function buildFakeBot(): FakeBot {
  const commandHandlers = new Map<string, (ctx: BotContext) => Promise<void>>();
  const callbackHandlers: FakeBot['callbackHandlers'] = [];
  return {
    commandHandlers,
    callbackHandlers,
    command(name, handler) {
      commandHandlers.set(name, handler);
    },
    callbackQuery(matcher, handler) {
      callbackHandlers.push({ matcher, handler });
    },
  };
}

interface FakeContext {
  from?: { id: number };
  match?: RegExpMatchArray | null;
  reply: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}

function buildFakeCtx(over: Partial<FakeContext> = {}): FakeContext {
  return {
    from: over.from ?? { id: 42 },
    match: over.match,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
}

function buildDeps(): {
  deps: PageDeps;
  userLocale: UserLocaleSyncCache & {
    store: Map<number, string>;
  };
  translator: TranslatorPort;
  adminCalls: string[];
} {
  const store = new Map<number, string>();
  const userLocale = {
    store,
    getSync: (id: number) => store.get(id) ?? 'ru',
    setSync: (id: number, lang: string) => {
      store.set(id, lang);
    },
    hasSync: (id: number) => store.has(id),
  };
  const translator: TranslatorPort = {
    t: (key, lang, vars) => {
      if (key === 'lang.choose') return `[${lang}] choose`;
      if (key === 'lang.ru') return `[${lang}] ru-label`;
      if (key === 'lang.en') return `[${lang}] en-label`;
      if (key === 'lang.changed') return `[${lang}] changed:${vars?.lang ?? ''}`;
      return key;
    },
    resolveButtonLabel: (_id, fallback) => fallback,
  };
  const adminCalls: string[] = [];
  const adminClient = {
    updateUserLanguage: vi.fn(async (telegramId: string, lang: string) => {
      adminCalls.push(`${telegramId}:${lang}`);
    }),
  } as unknown as PageDeps['adminClient'];

  return {
    deps: {
      adminClient,
      translator,
      userLocale,
      getConfig: async () => {
        throw new Error('unused');
      },
      urls: { publicWebUrl: null, miniAppUrl: null },
    },
    userLocale,
    translator,
    adminCalls,
  };
}

describe('registerLangPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers the /lang command and the lang:* callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    expect(bot.commandHandlers.has('lang')).toBe(true);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBeInstanceOf(RegExp);
  });

  it('/lang replies with the locale picker built from translator labels', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const handler = bot.commandHandlers.get('lang');
    expect(handler).toBeDefined();
    const ctx = buildFakeCtx();
    await handler!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toBe('[ru] choose');
  });

  it('/lang renders in the user\'s persisted locale (en)', async () => {
    const bot = buildFakeBot();
    const { deps, userLocale } = buildDeps();
    userLocale.setSync(42, 'en');
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('lang')!(ctx as unknown as BotContext);
    expect(ctx.reply.mock.calls[0][0]).toBe('[en] choose');
  });

  it('lang:* callback updates the cache, calls admin, confirms in new locale', async () => {
    const bot = buildFakeBot();
    const { deps, userLocale, adminCalls } = buildDeps();
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], deps);
    const handler = bot.callbackHandlers[0].handler;
    // grammy hands match as RegExpMatchArray with capture group [1].
    const ctx = buildFakeCtx({
      from: { id: 99 },
      match: ['lang:en', 'en'] as unknown as RegExpMatchArray,
    });
    await handler(ctx as unknown as BotContext);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(userLocale.getSync(99)).toBe('en');
    expect(adminCalls).toEqual(['99:en']);
    expect(ctx.reply).toHaveBeenCalledWith('[en] changed:English');
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
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    (deps.adminClient as unknown as { updateUserLanguage: ReturnType<typeof vi.fn> }).updateUserLanguage =
      vi.fn(async () => {
        throw new Error('boom');
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
    registerLangPage(bot as unknown as Parameters<typeof registerLangPage>[0], {
      ...deps,
      adminClient: null,
    });
    const handler = bot.callbackHandlers[0].handler;
    const ctx = buildFakeCtx({
      from: { id: 1 },
      match: ['lang:ru', 'ru'] as unknown as RegExpMatchArray,
    });
    await expect(handler(ctx as unknown as BotContext)).resolves.toBeUndefined();
  });
});
