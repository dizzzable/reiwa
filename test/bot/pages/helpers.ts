/**
 * Shared test fixtures for `bot/pages/*` specs.
 *
 * Builds a fake grammy bot that records command + callback handler
 * registrations, plus a fake `Context` factory and a `PageDeps`
 * builder driven by an in-memory locale map. Pages drive admin via
 * the AdminClient namespace facade — `buildDeps` accepts a partial
 * fake so each test only stubs the namespaces it touches.
 */
import { vi } from 'vitest';

import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type {
  BotContext,
  PageDeps,
  UserLocaleSyncCache,
} from '../../../src/bot/pages/types.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';

export interface FakeBot {
  commandHandlers: Map<string, (ctx: BotContext) => Promise<void>>;
  callbackHandlers: Array<{
    matcher: string | RegExp;
    handler: (ctx: BotContext) => Promise<void>;
  }>;
  command(name: string, handler: (ctx: BotContext) => Promise<void>): void;
  callbackQuery(matcher: string | RegExp, handler: (ctx: BotContext) => Promise<void>): void;
}

export function buildFakeBot(): FakeBot {
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

export interface FakeContext {
  from?: { id: number };
  match?: RegExpMatchArray | null;
  reply: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  editMessageCaption: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  callbackQuery?: { message?: unknown };
  chat?: { id: number };
  me?: { username: string };
  api: { sendMessage: ReturnType<typeof vi.fn> };
}

export function buildFakeCtx(over: Partial<FakeContext> = {}): FakeContext {
  return {
    from: over.from ?? { id: 42 },
    match: over.match,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    // `editOrReply` (STEALTHNET-style in-place edit) calls these instead
    // of `reply` for callback-driven screens. Without a `callbackQuery.message`
    // the helper takes the plain-text branch -> `editMessageText`.
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageCaption: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    callbackQuery: over.callbackQuery,
    chat: over.chat ?? { id: 99 },
    me: over.me ?? { username: 'reiwa_test_bot' },
    api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}

export function buildPassthroughTranslator(): TranslatorPort {
  return {
    t: (key, lang, vars) => {
      const varStr = vars
        ? Object.entries(vars)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')
        : '';
      return varStr.length > 0 ? `${lang}:${key}(${varStr})` : `${lang}:${key}`;
    },
    resolveButtonLabel: (_id, fallback) => fallback,
  };
}

export interface BuildDepsOptions {
  readonly initialLocale?: string;
  readonly initialUserId?: number;
  readonly config?: BotConfig;
  readonly publicWebUrl?: string | null;
  readonly miniAppUrl?: string | null;
  readonly adminOverrides?: Partial<PageDeps['adminClient']> | Record<string, unknown>;
}

export interface DepsBundle {
  deps: PageDeps;
  userLocale: UserLocaleSyncCache & { store: Map<number, string> };
  translator: TranslatorPort;
  configRef: { value: BotConfig };
}

export function buildDeps(options: BuildDepsOptions = {}): DepsBundle {
  const store = new Map<number, string>();
  if (options.initialLocale && options.initialUserId !== undefined) {
    store.set(options.initialUserId, options.initialLocale);
  }
  const userLocale = {
    store,
    getSync: (id: number) => store.get(id) ?? 'ru',
    setSync: (id: number, lang: string) => {
      store.set(id, lang);
    },
    hasSync: (id: number) => store.has(id),
  };

  const translator = buildPassthroughTranslator();
  const configRef = { value: options.config ?? DEFAULT_BOT_CONFIG };

  return {
    deps: {
      adminClient: (options.adminOverrides ?? null) as PageDeps['adminClient'],
      translator,
      userLocale,
      getConfig: async () => configRef.value,
      urls: {
        publicWebUrl: options.publicWebUrl ?? null,
        miniAppUrl: options.miniAppUrl ?? null,
        rezeisAdminUrl: null,
      },
    },
    userLocale,
    translator,
    configRef,
  };
}
