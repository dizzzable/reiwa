/**
 * The mandatory channel gate («Канал обязателен»), driven through grammY's real
 * `Bot` and `Api` against a local server playing the Bot API, with the platform
 * policy in the exact shape rezeis serves it.
 *
 * Why the page specs in `pages/start.test.ts` and `pages/menu.test.ts` never
 * caught the gate being off: every gate spec there hands the page a policy
 * rezeis never sends — `channelId: '@rezeis_news'`, or the key left out.
 * rezeis always sends every key (`mapInternalPlatformPolicy` in rezeis-admin
 * `settings.service.ts`), and «ID канала» is `Settings.channelId BigInt?`, so an
 * operator who fills «Ссылка на канал» and leaves the ID empty sends
 * `channelId: null`. The gate read that `null` as "an id is set", resolved the
 * chat to `null` and switched itself off: every user got the welcome screen,
 * subscribed or not, and nothing was logged.
 *
 * Telegram's side, as the Bot API server implements it (tdlib/td
 * `DialogParticipantManager::get_channel_participant`, telegram-bot-api
 * `Client::fail_query_with_error`):
 *  - a user who is not in the chat comes back as `status: "left"`, not an error;
 *  - in a channel where the bot is not an administrator every call fails with
 *    400 `Bad Request: member list is inaccessible`;
 *  - `restricted` carries `is_member`, false once the user has left.
 *
 * ── THE GATE THAT ONLY STOOD AT TWO DOORS ─────────────────────────────────
 *
 * Until 14.09.2026 the gate ran on `/start` and on «✅ Я подписался» and nowhere
 * else. A non-subscriber holding a menu message from before the gate was
 * switched on pressed its buttons straight into the pages; a quest deep link
 * showed its screen ahead of `/start`'s gate. The gate is now a middleware in
 * front of every page (`src/bot/middleware/channel-gate.ts`), so the bot in
 * `runBot` is wired the way `src/bot/main.ts` wires it — session, locale detect,
 * the gate, then the pages, with the gate's own short-timeout Telegram client
 * (here: one second, on the same local server) — and the last describe block
 * pins `main.ts` to that wiring. `reached` records every update that got past
 * the gate to the page layer: an empty list is the proof that no page ran.
 *
 * Why the gate's client matters to these specs: a `getChatMember` the local
 * server never answers is given up on by that client within a second. A path
 * that asked through `ctx.api` instead — grammY's 500-second default — would sit
 * until the gate module's own six-second deadline, past vitest's five-second
 * test timeout, and the spec would fail.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Api, Bot, MemorySessionStorage, session } from 'grammy';
import type { Chat, Update, UserFromGetMe } from 'grammy/types';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslatorPort } from '../../src/application/ports/translator.port.js';
import { createChannelGateApi } from '../../src/bot/lib/bot-channel-gate.js';
import {
  resetChannelGateMemory,
  settleChannelGateBackground,
  type ChannelGateStore,
} from '../../src/bot/lib/channel-gate.js';
import { createChannelGateMiddleware } from '../../src/bot/middleware/channel-gate.js';
import { createLocaleDetectMiddleware } from '../../src/bot/middleware/locale-detect.js';
import { registerAiSupportPage } from '../../src/bot/pages/ai-support.js';
import { resetChannelJoinPromptMemory } from '../../src/bot/pages/channel-join-prompt.js';
import { registerClosePage } from '../../src/bot/pages/close.js';
import { registerHelpCommandPage } from '../../src/bot/pages/help.js';
import { registerInlineSharePage } from '../../src/bot/pages/inline-share.js';
import { registerLangPage } from '../../src/bot/pages/lang.js';
import { registerMenuPage } from '../../src/bot/pages/menu.js';
import { registerPaymentsPage } from '../../src/bot/pages/payments.js';
import { registerPaySupportPage } from '../../src/bot/pages/paysupport.js';
import { registerQuestChannelPage } from '../../src/bot/pages/quest-channel.js';
import { registerStartPage } from '../../src/bot/pages/start.js';
import type { BotContext, BotSession, PageDeps } from '../../src/bot/pages/types.js';
import { PolicyCache, setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../src/infrastructure/bot-config/types.js';
import { RedisChannelGateStore } from '../../src/infrastructure/channel-gate/redis-channel-gate-store.js';
import { detectLocaleFromTelegram } from '../../src/infrastructure/i18n/locale-detector/locale-detector.js';
import { FakeRedis } from '../infrastructure/channel-gate/fake-redis.js';
import { buildPassthroughTranslator } from './pages/helpers.js';

/** Shaped like a real token; only ever sent to 127.0.0.1. */
const TOKEN = '123456789:AAHfakeTokenForChannelGateSpecs_0123456';

const BOT_INFO: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: 'Reiwa',
  username: 'reiwa_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const CHANNEL_ID = '-1001234567890';

/** How long «Перепроверять подписку» OFF keeps a pass in the store: 365 days. */
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** 21 chars — the CUID grammar both quest matchers enforce. */
const QUEST_ID = 'cabcdefghijklmnopqrst';

/**
 * `GET /api/internal/settings/platform-policy` for an operator who switched on
 * «Канал обязателен» and filled «Ссылка на канал» only. Every key present, the
 * empty «ID канала» and «Username канала» are `null`, the empty rules link `''`.
 */
function panelPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rulesRequired: false,
    rulesLink: '',
    channelRequired: true,
    channelLink: 'https://t.me/rezeis_news',
    channelId: null,
    channelUsername: null,
    channelRecheck: true,
    requireTelegramWebCredentials: false,
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'RUB',
    renewalAddOns: false,
    ...overrides,
  };
}

/** A Bot API answer, or `'hang'`: the local server never responds. */
type BotApiAnswer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error_code: number; readonly description: string }
  | 'hang';

interface BotApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/** Answers one Bot API method; `undefined` falls back to the default answer. `nth` counts from 0. */
type Answerer = (payload: Record<string, unknown>, nth: number) => BotApiAnswer | undefined;

const USER_A = { id: 4242, is_bot: false, first_name: 'Ann', language_code: 'ru' } as const;
const USER_B = { id: 4343, is_bot: false, first_name: 'Bob', language_code: 'ru' } as const;
type TestUser = typeof USER_A | typeof USER_B;

function member(status: string, extra: Record<string, unknown> = {}): BotApiAnswer {
  return { ok: true, result: { status, user: USER_A, ...extra } };
}

/** A local "Bot API": records each call (and on the shared timeline) and answers `getChatMember` as told. */
/** What one `runBot` tells the shared local Bot API, and what it records there. */
interface BotApiRun {
  readonly calls: BotApiCall[];
  readonly timeline: string[];
  readonly getChatMember: (payload: Record<string, unknown>) => BotApiAnswer;
  readonly answers: Readonly<Record<string, Answerer>>;
}

/**
 * ONE local Bot API server for the whole file, answering for whichever run is
 * current. It used to be one server per run — sixty-odd created and torn down
 * in a file — and the forks pool on Windows lost its worker every few runs of
 * this file (`vitest.config.ts` describes that death); a committed spec with a
 * handful of servers did not die in the same number of runs. One server, and
 * the keep-alive sockets grammY pools to it, lives from the first spec to the
 * last.
 */
async function startLocalBotApi(): Promise<{
  readonly apiRoot: string;
  readonly use: (run: BotApiRun | null) => void;
  readonly close: () => Promise<void>;
}> {
  let current: BotApiRun | null = null;
  let nextMessageId = 100;
  const server = http.createServer((req, res) => {
    const run = current;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = (body.length > 0 ? JSON.parse(body) : {}) as Record<string, unknown>;
      let answer: BotApiAnswer = { ok: true, result: true };
      const nth = run === null ? 0 : run.calls.filter((call) => call.method === method).length;
      run?.calls.push({ method, payload });
      run?.timeline.push(`api:${method}`);
      if (method === 'getChatMember' && run !== null) answer = run.getChatMember(payload);
      if (method === 'sendMessage' && Number(payload.chat_id) < 0 && hasWebAppButton(payload.reply_markup)) {
        // Telegram: a web_app button is "available only in private chats between a
        // user and the bot". A screen sent to a group fails here as it fails there.
        answer = { ok: false, error_code: 400, description: 'Bad Request: BUTTON_TYPE_INVALID' };
      } else if (method === 'sendMessage') {
        nextMessageId += 1;
        answer = {
          ok: true,
          result: {
            message_id: nextMessageId,
            date: 0,
            chat: { id: payload.chat_id, type: 'private', first_name: 'Ann' },
            text: payload.text,
          },
        };
      }
      if (
        (method === 'editMessageText' || method === 'editMessageMedia' || method === 'editMessageReplyMarkup' || method === 'sendPhoto') &&
        Number(payload.chat_id) < 0 &&
        hasWebAppButton(payload.reply_markup)
      ) {
        answer = { ok: false, error_code: 400, description: 'Bad Request: BUTTON_TYPE_INVALID' };
      }
      answer = run?.answers[method]?.(payload, nth) ?? answer;
      if (answer === 'hang') return;
      res.writeHead(answer.ok ? 200 : answer.error_code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    use: (run) => {
      current = run;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Whether an inline keyboard carries a Mini App button — JSON body or a multipart field. */
function hasWebAppButton(markup: unknown): boolean {
  const parsed: unknown = typeof markup === 'string' ? JSON.parse(markup) : markup;
  const rows = (parsed as { inline_keyboard?: unknown } | undefined)?.inline_keyboard;
  return (
    Array.isArray(rows) &&
    rows.some(
      (row) => Array.isArray(row) && row.some((button) => typeof button === 'object' && button !== null && 'web_app' in button),
    )
  );
}

let botApi: Awaited<ReturnType<typeof startLocalBotApi>>;

beforeAll(async () => {
  botApi = await startLocalBotApi();
});

afterAll(async () => {
  await botApi.close();
});

// ── Updates, as Telegram delivers them ──────────────────────────────────────

function privateChat(user: TestUser): Chat.PrivateChat {
  return { id: user.id, type: 'private', first_name: user.first_name };
}

const OPERATOR_GROUP: Chat.SupergroupChat = { id: -1009876543210, type: 'supergroup', title: 'Operators' };

function startUpdate(updateId: number, user: TestUser = USER_A, payload = ''): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: privateChat(user),
      from: user,
      text: payload.length > 0 ? `/start ${payload}` : '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  } as Update;
}

function commandUpdate(updateId: number, command: string, user: TestUser = USER_A): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: privateChat(user),
      from: user,
      text: `/${command}`,
      entities: [{ type: 'bot_command', offset: 0, length: command.length + 1 }],
    },
  } as Update;
}

function textUpdate(updateId: number, text: string, user: TestUser = USER_A): Update {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: 0, chat: privateChat(user), from: user, text },
  } as Update;
}

/** A button pressed on a message the bot sent this user earlier — an old menu, say. */
function callbackUpdate(updateId: number, data: string, user: TestUser = USER_A): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: user,
      chat_instance: 'ci-1',
      data,
      message: {
        message_id: 50,
        date: 0,
        chat: privateChat(user),
        from: BOT_INFO,
        text: 'an old menu',
      },
    },
  } as Update;
}

function checkChannelUpdate(updateId: number, data = 'check_channel'): Update {
  return callbackUpdate(updateId, data, USER_A);
}

/** A button on the bot's message in a group, pressed by USER_A. */
function groupCallbackUpdate(updateId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: USER_A,
      chat_instance: 'ci-group',
      data,
      message: { message_id: 60, date: 0, chat: OPERATOR_GROUP, from: BOT_INFO, text: 'a message in a group' },
    },
  } as Update;
}

/** `/start@reiwa_test_bot [payload]` typed in a group. */
function groupStartUpdate(updateId: number, payload = ''): Update {
  const command = '/start@reiwa_test_bot';
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: OPERATOR_GROUP,
      from: USER_A,
      text: payload.length > 0 ? `${command} ${payload}` : command,
      entities: [{ type: 'bot_command', offset: 0, length: command.length }],
    },
  } as Update;
}

/** Where a welcome screen's «Кабинет» buttons point when the Mini App is configured. */
const CABINET_URLS = {
  publicWebUrl: 'https://reiwa.example',
  miniAppUrl: 'https://reiwa.example/app',
  rezeisAdminUrl: null,
} as const;

const STARS_PAYMENT = {
  currency: 'XTR',
  total_amount: 250,
  invoice_payload: 'pay_stars_1',
  telegram_payment_charge_id: 'stxCharge1',
} as const;

function serviceMessageUpdate(updateId: number, fields: Record<string, unknown>): Update {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: 0, chat: privateChat(USER_A), from: USER_A, ...fields },
  } as Update;
}

/** Moves the clock between two updates; needs `vi.useFakeTimers({ toFake: ['Date'] })`. */
interface ClockStep {
  readonly advanceMs: number;
}
/** Changes the world between two updates — a user leaving the channel, say. */
interface ActionStep {
  readonly run: () => void;
}
/** Updates handled at the same time, as a runner with concurrency would. */
interface ConcurrentStep {
  readonly concurrently: readonly Update[];
}
type Step = Update | ClockStep | ActionStep | ConcurrentStep;

// ── The bot, wired the way `src/bot/main.ts` wires it ───────────────────────

interface RunOptions {
  /** `null`: no admin client, as a deploy without REZEIS_TOKEN runs. */
  readonly adminClient?: null;
  /** Other Bot API methods answered as told; the rest answer `{ ok: true, result: true }`. */
  readonly answers?: Readonly<Record<string, Answerer>>;
  readonly translator?: TranslatorPort;
  readonly config?: BotConfig;
  /** The gate's shared store, as `main.ts` wires it when REDIS_URL is set. */
  readonly store?: ChannelGateStore;
  /** Session data per chat id, present before the first update. */
  readonly sessions?: Readonly<Record<string, Record<string, unknown>>>;
  /** What `quests.channelTarget` answers. */
  readonly questTarget?: { readonly chatId: string; readonly joinUrl: string };
  /** `quests.channelTarget` fails instead, with this HTTP status on the error — as the admin transport throws. */
  readonly questTargetStatus?: number;
  /** What `user.exists` answers — `false` for a Telegram user rezeis has no account for. Default `true`. */
  readonly userExists?: boolean;
  /** The Cabinet URLs the pages build buttons from; none by default. */
  readonly urls?: PageDeps['urls'];
  /**
   * Wait for the gate's background work (store writes, operator alerts) before
   * returning — default true. `false` for a store that never answers.
   */
  readonly settle?: boolean;
}

type PolicySource = Record<string, unknown> | Error | (() => Promise<unknown>);

function buildAdmin(policy: PolicySource, timeline: string[], options: RunOptions) {
  const traced = <A extends unknown[], R>(name: string, impl: (...args: A) => Promise<R>) =>
    vi.fn(async (...args: A) => {
      timeline.push(`admin:${name}`);
      return impl(...args);
    });
  return {
    system: {
      // What the admin transport hands back: `JSON.parse` of the body rezeis wrote.
      getPlatformPolicy: traced('system.getPlatformPolicy', async () => {
        if (policy instanceof Error) throw policy;
        if (typeof policy === 'function') return policy();
        return JSON.parse(JSON.stringify(policy)) as unknown;
      }),
      reportError: vi.fn().mockResolvedValue({ ok: true }),
    },
    user: {
      bootstrap: traced('user.bootstrap', async () => null),
      exists: traced('user.exists', async () => ({ exists: options.userExists ?? true })),
      updateLanguage: vi.fn(async () => undefined),
    },
    subscription: { getAll: vi.fn(async () => ({ subscriptions: [] })) },
    webAuth: { issueBotSigninToken: vi.fn(async () => ({ token: 'signin-token' })) },
    trial: { getEligibility: vi.fn(async () => null) },
    linking: { telegram: { consume: traced('linking.telegram.consume', async () => ({ success: true })) } },
    advertising: { recordClick: traced('advertising.recordClick', async () => undefined) },
    payments: {
      forwardWebhook: vi.fn(async () => undefined),
      resolveStarsPreCheckout: vi.fn(async () => ({ approve: true, reason: null })),
    },
    quests: {
      channelTarget: traced('quests.channelTarget', async () => {
        if (options.questTargetStatus !== undefined) {
          throw Object.assign(new Error(`rezeis answered ${options.questTargetStatus}`), {
            status: options.questTargetStatus,
          });
        }
        return {
          questId: QUEST_ID,
          chatId: options.questTarget?.chatId ?? '@rezeis_quest',
          joinUrl: options.questTarget?.joinUrl ?? 'https://t.me/rezeis_quest',
        };
      }),
      verifyChannel: traced('quests.verifyChannel', async () => ({ state: 'COMPLETED' })),
    },
  };
}

async function runBot(
  policy: PolicySource,
  getChatMember: (payload: Record<string, unknown>) => BotApiAnswer,
  steps: readonly Step[],
  options: RunOptions = {},
): Promise<{
  readonly calls: BotApiCall[];
  readonly reportError: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly admin: ReturnType<typeof buildAdmin>;
  readonly reached: number[];
  readonly locales: Map<number, string>;
  readonly timeline: string[];
  readonly handledInMs: number[];
}> {
  const timeline: string[] = [];
  const calls: BotApiCall[] = [];
  botApi.use({ calls, timeline, getChatMember, answers: options.answers ?? {} });
  const admin = buildAdmin(policy, timeline, options);
  const warn = vi.fn();
  const logger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: () => logger,
  };
  const locales = new Map<number, string>();
  const deps: PageDeps = {
    adminClient: options.adminClient === null ? null : (admin as unknown as PageDeps['adminClient']),
    translator: options.translator ?? buildPassthroughTranslator(),
    userLocale: {
      getSync: (id) => locales.get(id) ?? 'ru',
      setSync: (id, lang) => {
        locales.set(id, lang);
      },
      hasSync: (id) => locales.has(id),
    },
    getConfig: async () => options.config ?? DEFAULT_BOT_CONFIG,
    urls: options.urls ?? { publicWebUrl: null, miniAppUrl: null, rezeisAdminUrl: null },
    logger: logger as unknown as PageDeps['logger'],
    // The gate's own client, one second here instead of five.
    channelGate: {
      api: createChannelGateApi(TOKEN, botApi.apiRoot, 1),
      ...(options.store !== undefined ? { store: options.store } : {}),
    },
  };
  const storage = new MemorySessionStorage<BotSession>();
  for (const [chatId, data] of Object.entries(options.sessions ?? {})) storage.write(chatId, data as BotSession);

  const bot = new Bot<BotContext>(TOKEN, { botInfo: BOT_INFO, client: { apiRoot: botApi.apiRoot } });
  const reached: number[] = [];
  bot.use(session({ initial: (): BotSession => ({}), storage }));
  bot.use(
    createLocaleDetectMiddleware({
      cache: deps.userLocale,
      detect: detectLocaleFromTelegram,
      adminClient: deps.adminClient,
    }),
  );
  bot.use(createChannelGateMiddleware(deps));
  // Everything registered from here on is "a page": nothing reaches one without passing this.
  bot.use(async (ctx, next) => {
    reached.push(ctx.update.update_id);
    await next();
  });
  // The pages these specs touch, in `main.ts` order.
  registerLangPage(bot, deps);
  registerInlineSharePage(bot, deps);
  registerHelpCommandPage(bot, deps);
  registerPaySupportPage(bot, deps);
  registerPaymentsPage(bot, deps);
  registerMenuPage(bot, deps);
  registerStartPage(bot, deps);
  registerQuestChannelPage(bot, deps);
  registerClosePage(bot, deps);
  registerAiSupportPage(bot, deps);
  const handledInMs: number[] = [];
  try {
    for (const step of steps) {
      if ('advanceMs' in step) vi.setSystemTime(Date.now() + step.advanceMs);
      else if ('run' in step) step.run();
      else if ('concurrently' in step) {
        const started = performance.now();
        await Promise.all(step.concurrently.map((update) => bot.handleUpdate(update)));
        handledInMs.push(performance.now() - started);
      } else {
        const started = performance.now();
        await bot.handleUpdate(step);
        handledInMs.push(performance.now() - started);
      }
    }
    if (options.settle !== false) await settleChannelGateBackground();
  } finally {
    botApi.use(null);
  }
  return { calls, reportError: admin.system.reportError, warn, admin, reached, locales, timeline, handledInMs };
}

function callsTo(calls: readonly BotApiCall[], method: string): BotApiCall[] {
  return calls.filter((call) => call.method === method);
}

function sentTexts(calls: readonly BotApiCall[]): unknown[] {
  return callsTo(calls, 'sendMessage').map((call) => call.payload.text);
}

interface KeyboardButton {
  readonly text: string;
  readonly url?: string;
  readonly callback_data?: string;
}

function keyboardOf(call: BotApiCall): KeyboardButton[] {
  const markup = call.payload.reply_markup as { inline_keyboard: KeyboardButton[][] };
  return markup.inline_keyboard.flat();
}

function welcomeCount(calls: readonly BotApiCall[]): number {
  return sentTexts(calls).filter(
    (text) => text !== 'ru:channel.required' && text !== 'ru:channel.not_subscribed',
  ).length;
}

function toasts(calls: readonly BotApiCall[]): unknown[] {
  return callsTo(calls, 'answerCallbackQuery').map((call) => call.payload.text);
}

/** The join prompt `/start` sent before the gate became a middleware, for `panelPolicy()`. */
const JOIN_PROMPT = {
  text: 'ru:channel.required',
  reply_markup: {
    inline_keyboard: [
      [{ text: 'ru:channel.join_button', url: 'https://t.me/rezeis_news' }],
      [{ text: 'ru:channel.check_button', callback_data: 'check_channel' }],
    ],
  },
};

function promptPayloads(calls: readonly BotApiCall[]): Array<Record<string, unknown>> {
  return callsTo(calls, 'sendMessage')
    .filter((call) => String(call.payload.text).endsWith(':channel.required'))
    .map(({ payload }) => ({ text: payload.text, reply_markup: payload.reply_markup }));
}

function useClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
}

beforeEach(() => {
  // Process singletons; a spec must not inherit the previous one's.
  setPolicyCache(null);
  resetChannelGateMemory();
  resetChannelJoinPromptMemory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('channel gate — «Ссылка на канал» set, «ID канала» empty (channelId: null)', () => {
  it('/start asks Telegram about the user and stops a non-subscriber at the join prompt', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('left'), [startUpdate(1)]);

    expect(callsTo(calls, 'getChatMember').map((call) => call.payload)).toEqual([
      { chat_id: '@rezeis_news', user_id: USER_A.id },
    ]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
    const buttons = keyboardOf(callsTo(calls, 'sendMessage')[0]);
    expect(buttons.find((button) => button.url !== undefined)?.url).toBe('https://t.me/rezeis_news');
    expect(buttons.find((button) => button.callback_data !== undefined)?.callback_data).toBe('check_channel');
  });

  it('«Я подписался» (check_channel) keeps a user who has not joined out', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('left'), [checkChannelUpdate(2)]);

    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(callsTo(calls, 'answerCallbackQuery').map((call) => call.payload.text)).toEqual([
      'ru:channel.not_subscribed',
    ]);
    expect(sentTexts(calls)).toEqual(['ru:channel.not_subscribed']);
  });

  it('«Я подписался» refused again and again: a toast on every press, the message at most once per 30 seconds', async () => {
    useClock();
    const { calls } = await runBot(panelPolicy(), () => member('left'), [
      checkChannelUpdate(180),
      { advanceMs: 2_000 },
      checkChannelUpdate(181),
      { advanceMs: 27_999 },
      checkChannelUpdate(182),
      { advanceMs: 1 },
      checkChannelUpdate(183),
    ]);

    expect(toasts(calls)).toEqual([
      'ru:channel.not_subscribed',
      'ru:channel.not_subscribed',
      'ru:channel.not_subscribed',
      'ru:channel.not_subscribed',
    ]);
    expect(sentTexts(calls)).toEqual(['ru:channel.not_subscribed', 'ru:channel.not_subscribed']);
  });

  it('«Я подписался» whose message failed to send: the press is still answered, and the next press sends it', async () => {
    useClock();
    const { calls, warn } = await runBot(
      panelPolicy(),
      () => member('left'),
      [checkChannelUpdate(185), { advanceMs: 2_000 }, checkChannelUpdate(186)],
      {
        answers: {
          sendMessage: (_payload, nth) => (nth === 0 ? { ok: false, error_code: 502, description: 'Bad Gateway' } : undefined),
        },
      },
    );

    expect(toasts(calls)).toEqual(['ru:channel.not_subscribed', 'ru:channel.not_subscribed']);
    // The first send failed (the server saw it), the second press sent it again.
    expect(sentTexts(calls)).toEqual(['ru:channel.not_subscribed', 'ru:channel.not_subscribed']);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('not-subscribed notice could not be sent'))).toHaveLength(1);
  });

  it('«Я подписался» (check_channel) lets the user in once Telegram reports them a member', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('member'), [checkChannelUpdate(3)]);

    expect(callsTo(calls, 'getChatMember').map((call) => call.payload.chat_id)).toEqual(['@rezeis_news']);
    expect(callsTo(calls, 'answerCallbackQuery').map((call) => call.payload.text)).toEqual([
      'ru:channel.verified',
    ]);
    expect(welcomeCount(calls)).toBe(1);
  });
});

describe('channel gate — other channel references rezeis can send', () => {
  it('a link typed into «Username канала» (Branding) is checked as @username', async () => {
    const policy = panelPolicy({ channelLink: '', channelUsername: 'https://t.me/rezeis_news' });
    const { calls } = await runBot(policy, () => member('left'), [startUpdate(4)]);

    expect(callsTo(calls, 'getChatMember').map((call) => call.payload.chat_id)).toEqual(['@rezeis_news']);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
    const joinButton = keyboardOf(callsTo(calls, 'sendMessage')[0]).find((button) => button.url !== undefined);
    expect(joinButton?.url).toBe('https://t.me/rezeis_news');
  });

  it('a user who left while restricted (is_member: false) is not subscribed', async () => {
    const policy = panelPolicy({ channelId: CHANNEL_ID });
    const { calls } = await runBot(
      policy,
      () => member('restricted', { is_member: false, until_date: 0 }),
      [startUpdate(5)],
    );

    expect(callsTo(calls, 'getChatMember').map((call) => call.payload.chat_id)).toEqual([CHANNEL_ID]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });
});

describe('channel gate — cannot verify: users are let in, the operator is told', () => {
  it('bot is not a channel administrator: Telegram refuses once, both users get in, one report names the fix', async () => {
    const policy = panelPolicy({ channelId: CHANNEL_ID });
    const { calls, reportError, warn } = await runBot(
      policy,
      () => ({ ok: false, error_code: 400, description: 'Bad Request: member list is inaccessible' }),
      [startUpdate(6, USER_A), startUpdate(7, USER_B)],
    );

    // Fail open: a Telegram refusal never locks a (possibly paying) user out —
    // and the refused chat is not asked about again for the second user.
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(welcomeCount(calls)).toBe(2);
    expect(sentTexts(calls)).not.toContain('ru:channel.required');

    // …but it is no longer silent. Reported once, not once per user.
    expect(reportError).toHaveBeenCalledTimes(1);
    const report = reportError.mock.calls[0][0] as { source: string; level: string; message: string };
    expect(report.source).toBe('bot');
    expect(report.level).toBe('warning');
    expect(report.message).toContain(CHANNEL_ID);
    expect(report.message).toContain('member list is inaccessible');
    expect(report.message).toContain('administrator');
    const gateWarnings = warn.mock.calls.filter((args) => String(args[1]).includes('member list is inaccessible'));
    expect(gateWarnings).toHaveLength(1);
  });

  it('only a private invite link and no «ID канала»: nothing Telegram can check, so the operator is told', async () => {
    const inviteLink = 'https://t.me/+AbCdEfGhIjk';
    const { calls, reportError, warn } = await runBot(
      panelPolicy({ channelLink: inviteLink }),
      () => member('left'),
      [startUpdate(8, USER_A), startUpdate(9, USER_B)],
    );

    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(welcomeCount(calls)).toBe(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    const report = reportError.mock.calls[0][0] as { level: string; message: string };
    expect(report.level).toBe('warning');
    expect(report.message).toContain(inviteLink);
    expect(report.message).toContain('«ID канала»');
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('«ID канала»'))).toHaveLength(1);
  });
});

describe('channel gate in front of every update — a non-subscriber is stopped', () => {
  it('a button on an old menu: toast + join prompt, and the page never runs', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      callbackUpdate(10, 'back_to_menu'),
    ]);

    expect(reached).toEqual([]);
    expect(callsTo(calls, 'getChatMember').map((call) => call.payload)).toEqual([
      { chat_id: '@rezeis_news', user_id: USER_A.id },
    ]);
    expect(callsTo(calls, 'answerCallbackQuery').map((call) => call.payload)).toEqual([
      { callback_query_id: 'cq-10', text: 'ru:channel.not_subscribed' },
    ]);
    // Not `ru:menu.choose_action`: the menu page did not answer.
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('a text message: join prompt, and the page never runs', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [textUpdate(11, 'hello')]);

    expect(reached).toEqual([]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(callsTo(calls, 'answerCallbackQuery')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('/help, with the real help page registered, is stopped like any command', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [commandUpdate(12, 'help')]);

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('/help reaches the help page for a subscriber — the page is really there', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('member'), [commandUpdate(13, 'help')]);

    expect(reached).toEqual([13]);
    expect(sentTexts(calls)).toEqual(['ru:support.not_configured']);
  });

  it('an edited message is stopped the same way', async () => {
    const edited = {
      update_id: 14,
      edited_message: {
        message_id: 14,
        date: 0,
        edit_date: 1,
        chat: privateChat(USER_A),
        from: USER_A,
        text: 'hello, edited',
      },
    } as Update;
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [edited]);

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('the quest verify button (quest_channel:<id>) is asked about fresh', async () => {
    const { calls, reached, admin } = await runBot(panelPolicy(), () => member('left'), [
      textUpdate(15, 'hello'),
      callbackUpdate(16, `quest_channel:${QUEST_ID}`),
    ]);

    expect(reached).toEqual([]);
    // The text message left a "not subscribed" in memory; the verify button asked again anyway.
    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
    expect(admin.quests.channelTarget).not.toHaveBeenCalled();
    expect(admin.quests.verifyChannel).not.toHaveBeenCalled();
    expect(toasts(calls)).toEqual(['ru:channel.not_subscribed']);
  });

  it('a refused quest verify button prompts with the quest carried through «Я подписался»', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      callbackUpdate(116, `quest_channel:${QUEST_ID}`),
    ]);

    expect(reached).toEqual([]);
    const [prompt] = callsTo(calls, 'sendMessage');
    expect(prompt.payload.text).toBe('ru:channel.required');
    expect(keyboardOf(prompt).map((button) => button.callback_data).filter(Boolean)).toEqual([
      `check_channel:q:${QUEST_ID}`,
    ]);
  });

  it('data from a Mini App keyboard button (web_app_data) is something the user sent, and is stopped', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      serviceMessageUpdate(117, { web_app_data: { data: '{"plan":"pro"}', button_text: 'Open' } }),
    ]);

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('a burst of messages costs one Telegram call and one prompt, not one of each per message', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      textUpdate(17, 'one'),
      textUpdate(18, 'two'),
      textUpdate(19, 'three'),
    ]);

    expect(reached).toEqual([]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('every refused button still gets its toast while the prompt is held back', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      callbackUpdate(20, 'back_to_menu'),
      callbackUpdate(21, 'invite'),
    ]);

    expect(reached).toEqual([]);
    expect(toasts(calls)).toEqual(['ru:channel.not_subscribed', 'ru:channel.not_subscribed']);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('/start, then a message inside the prompt interval: one prompt, not two', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      startUpdate(22),
      textUpdate(23, 'hello?'),
    ]);

    expect(reached).toEqual([22]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('a message, then /start inside the interval: /start always answers — it is the front door', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('left'), [textUpdate(118, 'hello'), startUpdate(119)]);

    expect(sentTexts(calls)).toEqual(['ru:channel.required', 'ru:channel.required']);
  });

  it('is prompted again once the interval has passed', async () => {
    useClock();
    const { calls } = await runBot(panelPolicy(), () => member('left'), [
      textUpdate(24, 'hello'),
      { advanceMs: 29_999 },
      textUpdate(25, 'hello?'),
      { advanceMs: 1 },
      textUpdate(26, 'anyone?'),
    ]);

    expect(sentTexts(calls)).toEqual(['ru:channel.required', 'ru:channel.required']);
  });

  it('a prompt that failed to send is not remembered: the next update prompts again, and still nothing runs', async () => {
    const { calls, reached, warn } = await runBot(
      panelPolicy(),
      () => member('left'),
      [textUpdate(27, 'hello'), textUpdate(28, 'hello?')],
      {
        answers: {
          sendMessage: (_payload, nth) =>
            nth === 0 ? { ok: false, error_code: 502, description: 'Bad Gateway' } : undefined,
        },
      },
    );

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required', 'ru:channel.required']);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('join prompt could not be sent'))).toHaveLength(1);
  });

  it('a toast Telegram refuses does not cost the prompt', async () => {
    const { calls, reached } = await runBot(
      panelPolicy(),
      () => member('left'),
      [callbackUpdate(29, 'back_to_menu')],
      {
        answers: {
          answerCallbackQuery: () => ({
            ok: false,
            error_code: 400,
            description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
          }),
        },
      },
    );

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('/cancel outside AI-support mode is a command like any other', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [commandUpdate(30, 'cancel')]);

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('/cancel with AI-support mode switched off in the session is a command like any other too', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [commandUpdate(184, 'cancel')], {
      sessions: { [String(USER_A.id)]: { aiSupportMode: false } },
    });

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('anything else a user sends is stopped too: photos, stickers, voice, files, contacts, places, polls, dice', async () => {
    const file = (id: string): Record<string, unknown> => ({ file_id: id, file_unique_id: `${id}-u` });
    const sent: ReadonlyArray<Record<string, unknown>> = [
      { photo: [{ ...file('photo'), width: 90, height: 90 }] },
      { sticker: { ...file('sticker'), type: 'regular', width: 512, height: 512, is_animated: false, is_video: false } },
      { voice: { ...file('voice'), duration: 3 } },
      { video: { ...file('video'), width: 1, height: 1, duration: 1 } },
      { video_note: { ...file('note'), length: 1, duration: 1 } },
      { animation: { ...file('gif'), width: 1, height: 1, duration: 1 } },
      { audio: { ...file('audio'), duration: 1 } },
      { document: file('document') },
      { contact: { phone_number: '+10000000000', first_name: 'Ann' } },
      { location: { latitude: 55.75, longitude: 37.61 } },
      { venue: { location: { latitude: 55.75, longitude: 37.61 }, title: 'Office', address: 'Moscow' } },
      {
        poll: {
          id: 'poll-1',
          question: 'Q?',
          options: [],
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: true,
          type: 'regular',
          allows_multiple_answers: false,
        },
      },
      { dice: { emoji: '🎲', value: 3 } },
    ];
    const { calls, reached } = await runBot(
      panelPolicy(),
      () => member('left'),
      sent.map((fields, index) => serviceMessageUpdate(190 + index, fields)),
    );

    // Every one of them stopped: not one reached the page layer.
    expect(reached).toEqual([]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('updates handled at the same time send one prompt, not one each', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      { concurrently: [textUpdate(205, 'one'), textUpdate(206, 'two'), callbackUpdate(207, 'back_to_menu')] },
    ]);

    expect(reached).toEqual([]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
  });

  it('a prompt that has to carry a quest is sent even right after a plain one — and once per quest', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      textUpdate(208, 'hello'),
      callbackUpdate(209, `quest_channel:${QUEST_ID}`),
      callbackUpdate(210, `quest_channel:${QUEST_ID}`),
      textUpdate(211, 'hello?'),
    ]);

    expect(reached).toEqual([]);
    const checkButtons = callsTo(calls, 'sendMessage').map((call) =>
      keyboardOf(call)
        .map((button) => button.callback_data)
        .filter(Boolean),
    );
    // The plain prompt, then the one «Я подписался» continues to the quest from.
    // The same quest again, and a plain message after it, are inside the interval.
    expect(checkButtons).toEqual([['check_channel'], [`check_channel:q:${QUEST_ID}`]]);
    expect(toasts(calls)).toEqual(['ru:channel.not_subscribed', 'ru:channel.not_subscribed']);
  });
});

describe('channel gate in front of every update — what a non-subscriber still gets through', () => {
  it('/start link_<code>: the code is consumed and the user bootstrapped, then the join prompt', async () => {
    const { calls, admin, reached } = await runBot(panelPolicy(), () => member('left'), [
      startUpdate(31, USER_A, 'link_123456'),
    ]);

    expect(reached).toEqual([31]);
    expect(admin.linking.telegram.consume).toHaveBeenCalledWith(String(USER_A.id), '123456');
    expect(admin.user.bootstrap).toHaveBeenCalledTimes(1);
    expect(sentTexts(calls)).toEqual(['ru:link.success', 'ru:channel.required']);
  });

  it('/start is a fresh door: a user who joined after a remembered "not subscribed" is let in at once', async () => {
    let status = 'left';
    const { calls, reached } = await runBot(panelPolicy(), () => member(status), [
      textUpdate(218, 'hello'),
      { run: () => (status = 'member') },
      startUpdate(219),
    ]);

    expect(reached).toEqual([219]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
    expect(sentTexts(calls)[0]).toBe('ru:channel.required');
    expect(welcomeCount(calls)).toBe(1);
  });

  it('/start whose join prompt fails to send still stops the user — the welcome screen is not the fallback', async () => {
    const { calls, warn } = await runBot(panelPolicy(), () => member('left'), [startUpdate(220)], {
      answers: {
        sendMessage: (_payload, nth) => (nth === 0 ? { ok: false, error_code: 502, description: 'Bad Gateway' } : undefined),
      },
    });

    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
    expect(welcomeCount(calls)).toBe(0);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('the user stays stopped'))).toHaveLength(1);
  });

  it('/start ad_<code>: the ad click is recorded BEFORE the gate asks Telegram or prompts', async () => {
    const { calls, timeline } = await runBot(panelPolicy(), () => member('left'), [
      startUpdate(32, USER_A, 'ad_spring_2026'),
    ]);

    expect(sentTexts(calls)).toEqual(['ru:channel.required']);
    const click = timeline.indexOf('admin:advertising.recordClick');
    expect(click).toBeGreaterThan(-1);
    expect(click).toBeLessThan(timeline.indexOf('api:getChatMember'));
    expect(click).toBeLessThan(timeline.indexOf('api:sendMessage'));
  });

  it('/start payment_return still answers, and nobody asks Telegram', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('left'), [
      startUpdate(33, USER_A, 'payment_return'),
    ]);

    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual(['ru:payment_return.title']);
  });

  it('/start typed in a group sends nothing at all and bootstraps nobody — no welcome with a sign-in token, no quest, no link', async () => {
    for (const status of ['left', 'member']) {
      resetChannelGateMemory();
      setPolicyCache(null);
      const { calls, admin, reached } = await runBot(
        panelPolicy(),
        () => member(status),
        [groupStartUpdate(34), groupStartUpdate(212, `quest_channel_${QUEST_ID}`), groupStartUpdate(213, 'link_123456')],
        { urls: CABINET_URLS },
      );

      // The gate lets a group through — it is not the user's chat — and /start itself answers nothing there.
      expect(reached, status).toEqual([34, 212, 213]);
      expect(calls, status).toEqual([]);
      expect(admin.user.bootstrap, status).not.toHaveBeenCalled();
      expect(admin.webAuth.issueBotSigninToken, status).not.toHaveBeenCalled();
      expect(admin.quests.channelTarget, status).not.toHaveBeenCalled();
      expect(admin.linking.telegram.consume, status).not.toHaveBeenCalled();
    }
  });

  it('buttons pressed on a message in a group answer the press and nothing else — no screen, no sign-in token, no check', async () => {
    const { calls, admin, reached } = await runBot(
      panelPolicy(),
      () => member('member'),
      [
        groupCallbackUpdate(214, 'menu:main'),
        groupCallbackUpdate(215, 'back_to_menu'),
        groupCallbackUpdate(216, 'check_channel'),
        groupCallbackUpdate(217, `check_channel:q:${QUEST_ID}`),
      ],
      { urls: CABINET_URLS },
    );

    expect(reached).toEqual([214, 215, 216, 217]);
    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'answerCallbackQuery',
      'answerCallbackQuery',
      'answerCallbackQuery',
    ]);
    expect(toasts(calls)).toEqual([undefined, undefined, undefined, undefined]);
    expect(admin.webAuth.issueBotSigninToken).not.toHaveBeenCalled();
    expect(admin.quests.channelTarget).not.toHaveBeenCalled();
  });

  it('(the local Bot API refuses a web_app button outside a private chat, as Telegram does)', async () => {
    const calls: BotApiCall[] = [];
    botApi.use({ calls, timeline: [], getChatMember: () => member('left'), answers: {} });
    try {
      const api = new Api(TOKEN, { apiRoot: botApi.apiRoot });
      const markup = { inline_keyboard: [[{ text: 'Кабинет', web_app: { url: CABINET_URLS.miniAppUrl } }]] };
      await expect(api.sendMessage(OPERATOR_GROUP.id, 'menu', { reply_markup: markup })).rejects.toThrow(
        'BUTTON_TYPE_INVALID',
      );
      await expect(api.sendMessage(USER_A.id, 'menu', { reply_markup: markup })).resolves.toMatchObject({ text: 'menu' });
    } finally {
      botApi.use(null);
    }
  });

  it('/paysupport answers: a buyer who left the channel still has a charge to ask about', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [commandUpdate(35, 'paysupport')]);

    expect(reached).toEqual([35]);
    expect(sentTexts(calls)).toEqual(['ru:paysupport.unavailable']);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
  });

  it('a Stars successful_payment reaches rezeis and is acknowledged', async () => {
    const payment = serviceMessageUpdate(36, {
      successful_payment: { ...STARS_PAYMENT, provider_payment_charge_id: '' },
    });
    const { calls, admin, reached } = await runBot(panelPolicy(), () => member('left'), [payment]);

    expect(reached).toEqual([36]);
    expect(admin.payments.forwardWebhook).toHaveBeenCalledWith('TELEGRAM_STARS', payment);
    expect(sentTexts(calls)).toEqual(['ru:payments.stars.received']);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
  });

  it('a Stars refund reaches rezeis', async () => {
    const refund = serviceMessageUpdate(37, { refunded_payment: STARS_PAYMENT });
    const { calls, admin, reached } = await runBot(panelPolicy(), () => member('left'), [refund]);

    expect(reached).toEqual([37]);
    expect(admin.payments.forwardWebhook).toHaveBeenCalledWith('TELEGRAM_STARS', refund);
    expect(sentTexts(calls)).toEqual([]);
  });

  it('Telegram’s own service messages pass silently: a browser-cabinet sign-in, a write-access grant', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      // Posted when somebody signs in to the BROWSER cabinet with the Telegram widget.
      serviceMessageUpdate(38, { connected_website: 'cabinet.example.com' }),
      serviceMessageUpdate(39, { write_access_allowed: { from_request: true } }),
    ]);

    expect(reached).toEqual([38, 39]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(calls.filter((call) => call.method !== 'getChatMember')).toEqual([]);
  });

  it('a message in a group passes, and nobody asks Telegram', async () => {
    const group = {
      update_id: 40,
      message: { message_id: 40, date: 0, chat: OPERATOR_GROUP, from: USER_A, text: 'hello' },
    } as Update;
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [group]);

    expect(reached).toEqual([40]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual([]);
  });

  it('updates that are not a user acting in their own chat pass: pre-checkout, inline, blocked-bot, buttons elsewhere', async () => {
    const preCheckout = {
      update_id: 41,
      pre_checkout_query: { id: 'pcq-41', from: USER_A, currency: 'XTR', total_amount: 250, invoice_payload: 'pay_stars_1' },
    } as Update;
    const inline = {
      update_id: 42,
      inline_query: { id: 'iq-42', from: USER_A, query: '', offset: '' },
    } as Update;
    const blocked = {
      update_id: 43,
      my_chat_member: {
        chat: privateChat(USER_A),
        from: USER_A,
        date: 0,
        old_chat_member: { status: 'member', user: BOT_INFO },
        new_chat_member: { status: 'kicked', user: BOT_INFO, until_date: 0 },
      },
    } as Update;
    // Data no page handles: a page answering it would `ctx.reply` into a chat this
    // update does not have, which is a different failure from the one under test.
    const inlineMessageButton = {
      update_id: 44,
      callback_query: { id: 'cq-44', from: USER_A, chat_instance: 'ci-2', inline_message_id: 'im-1', data: 'share:open' },
    } as Update;
    // A business chat is private and carries the customer's id, like the bot's
    // own chat with them; a reply there would speak as the business account.
    const businessChatButton = {
      update_id: 45,
      callback_query: {
        id: 'cq-45',
        from: USER_A,
        chat_instance: 'ci-3',
        data: 'share:open',
        message: {
          message_id: 7,
          date: 0,
          chat: privateChat(USER_A),
          from: BOT_INFO,
          text: 'sent on behalf of a business',
          business_connection_id: 'bc-1',
        },
      },
    } as Update;
    // A private chat that is not this user's chat with the bot.
    const someoneElsesChatButton = {
      update_id: 46,
      callback_query: {
        id: 'cq-46',
        from: USER_A,
        chat_instance: 'ci-4',
        data: 'share:open',
        message: { message_id: 8, date: 0, chat: privateChat(USER_B), from: BOT_INFO, text: 'elsewhere' },
      },
    } as Update;
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [
      preCheckout,
      inline,
      blocked,
      inlineMessageButton,
      businessChatButton,
      someoneElsesChatButton,
    ]);

    expect(reached).toEqual([41, 42, 43, 44, 45, 46]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(callsTo(calls, 'answerPreCheckoutQuery').map((call) => call.payload)).toEqual([
      { pre_checkout_query_id: 'pcq-41', ok: true },
    ]);
    expect(callsTo(calls, 'answerInlineQuery')).toHaveLength(1);
    expect(sentTexts(calls)).toEqual([]);
  });

  it('the language picker passes, and the next prompt comes in the language just picked', async () => {
    const { calls, reached, locales } = await runBot(panelPolicy(), () => member('left'), [
      textUpdate(47, 'hello'),
      commandUpdate(48, 'lang'),
      callbackUpdate(49, 'lang:en'),
      textUpdate(50, 'hello again'),
    ]);

    expect(reached).toEqual([48, 49]);
    expect(locales.get(USER_A.id)).toBe('en');
    // All inside one prompt interval: the fourth message prompts again only
    // because the language changed.
    expect(sentTexts(calls)).toEqual([
      'ru:channel.required',
      'ru:lang.choose',
      'en:lang.changed(lang=en:lang.name.en)',
      'en:channel.required',
    ]);
  });

  it('«❌ Закрыть» on an operator card passes', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('left'), [callbackUpdate(51, 'close')]);

    expect(reached).toEqual([51]);
    expect(toasts(calls)).toEqual([undefined]);
    expect(callsTo(calls, 'deleteMessage')).toHaveLength(1);
    expect(sentTexts(calls)).toEqual([]);
  });

  it('the ways out of AI-support mode pass: /cancel while in the mode, and the exit button', async () => {
    const { calls, reached } = await runBot(
      panelPolicy(),
      () => member('left'),
      [commandUpdate(52, 'cancel'), callbackUpdate(53, 'ai_support_exit')],
      { sessions: { [String(USER_A.id)]: { aiSupportMode: true } } },
    );

    expect(reached).toEqual([52, 53]);
    expect(sentTexts(calls)).toEqual(['ru:ai_support.exited']);
    expect(callsTo(calls, 'editMessageText').map((call) => call.payload.text)).toEqual(['ru:ai_support.exited']);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
  });
});

describe('the quest deep link ends on the quest', () => {
  // Both doors in each flow are fresh, and a fresh door reuses its answer for two
  // seconds — so the user's join, between them, takes two seconds here too.
  it('when the quest is about the gate’s own channel, a non-subscriber is shown the quest itself', async () => {
    useClock();
    let status = 'left';
    const { calls, admin } = await runBot(
      panelPolicy(),
      () => member(status),
      [
        startUpdate(60, USER_A, `quest_channel_${QUEST_ID}`),
        { run: () => (status = 'member') },
        { advanceMs: 2_000 },
        callbackUpdate(61, `quest_channel:${QUEST_ID}`),
      ],
      { questTarget: { chatId: '@rezeis_news', joinUrl: 'https://t.me/rezeis_news' } },
    );

    expect(sentTexts(calls)).toEqual(['ru:quests.channel.prompt']);
    expect(keyboardOf(callsTo(calls, 'sendMessage')[0]).map((button) => button.callback_data ?? button.url)).toEqual([
      'https://t.me/rezeis_news',
      `quest_channel:${QUEST_ID}`,
    ]);
    // The verify button passed the gate fresh, and the quest recorded the completion.
    expect(admin.quests.verifyChannel).toHaveBeenCalledTimes(1);
    expect(toasts(calls)).toEqual(['ru:quests.channel.verified']);
  });

  it('when the quest is about another channel, the gate prompt carries the quest and «Я подписался» continues to it', async () => {
    useClock();
    let status = 'left';
    const { calls, admin } = await runBot(panelPolicy(), () => member(status), [
      startUpdate(62, USER_A, `quest_channel_${QUEST_ID}`),
      { run: () => (status = 'member') },
      { advanceMs: 2_000 },
      checkChannelUpdate(63, `check_channel:q:${QUEST_ID}`),
    ]);

    const [prompt, quest] = callsTo(calls, 'sendMessage');
    expect(prompt.payload.text).toBe('ru:channel.required');
    expect(keyboardOf(prompt).map((button) => button.callback_data).filter(Boolean)).toEqual([
      `check_channel:q:${QUEST_ID}`,
    ]);
    expect(toasts(calls)).toEqual(['ru:channel.verified']);
    expect(quest.payload.text).toBe('ru:quests.channel.prompt');
    expect(keyboardOf(quest).map((button) => button.callback_data ?? button.url)).toEqual([
      'https://t.me/rezeis_quest',
      `quest_channel:${QUEST_ID}`,
    ]);
    expect(admin.quests.channelTarget).toHaveBeenCalledTimes(2);
    expect(sentTexts(calls)).toHaveLength(2);
  });

  it('/start quest_channel_<id> still shows the quest to a subscriber', async () => {
    const { calls, admin } = await runBot(panelPolicy(), () => member('member'), [
      startUpdate(64, USER_A, `quest_channel_${QUEST_ID}`),
    ]);

    expect(admin.quests.channelTarget).toHaveBeenCalledTimes(1);
    expect(sentTexts(calls)).toEqual(['ru:quests.channel.prompt']);
  });

  it('«Я подписался» carrying a quest rezeis cannot show ends on the welcome screen, not on a dead end', async () => {
    const { calls, admin } = await runBot(
      panelPolicy(),
      () => member('member'),
      [checkChannelUpdate(65, `check_channel:q:${QUEST_ID}`)],
      { questTargetStatus: 503 },
    );

    expect(admin.quests.channelTarget).toHaveBeenCalledTimes(1);
    expect(toasts(calls)).toEqual(['ru:channel.verified']);
    expect(sentTexts(calls)).toHaveLength(1);
    expect(sentTexts(calls)).not.toContain('ru:quests.channel.retry');
    expect(welcomeCount(calls)).toBe(1);
  });

  it('…and with no account linked to this Telegram (404) says so first, as the quest’s own button does', async () => {
    const { calls } = await runBot(
      panelPolicy(),
      () => member('member'),
      [checkChannelUpdate(66, `check_channel:q:${QUEST_ID}`)],
      { questTargetStatus: 404 },
    );

    expect(toasts(calls)).toEqual(['ru:channel.verified']);
    const texts = sentTexts(calls);
    expect(texts[0]).toBe('ru:quests.channel.link_first');
    expect(texts).toHaveLength(2);
  });
});

describe('«✅ Я подписался» under the RESTRICTED access mode', () => {
  it('answers "service unavailable", like menu:main, before Telegram is asked or the welcome screen sent', async () => {
    const { calls } = await runBot(panelPolicy({ accessMode: 'RESTRICTED' }), () => member('member'), [
      checkChannelUpdate(70),
    ]);

    expect(callsTo(calls, 'answerCallbackQuery').map((call) => call.payload)).toEqual([
      { callback_query_id: 'cq-70', text: 'ru:access_mode.restricted', show_alert: true },
    ]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual([]);
  });
});

describe('«✅ Я подписался» for a newcomer /start refused under INVITED or REG_BLOCKED', () => {
  // The gate middleware sends its prompt to everybody it stops — a newcomer
  // `/start` has just refused included — so the button on it must not open the
  // welcome screen of the service that refused them.
  it.each([
    ['INVITED', 'ru:access_mode.invited_no_code'],
    ['REG_BLOCKED', 'ru:access_mode.reg_blocked_new'],
  ])('under %s answers the refusal /start gave, before Telegram is asked or the welcome screen sent', async (accessMode, refusal) => {
    const { calls, admin } = await runBot(panelPolicy({ accessMode }), () => member('member'), [checkChannelUpdate(71)], {
      userExists: false,
    });

    expect(admin.user.exists).toHaveBeenCalledWith({ telegramId: String(USER_A.id) });
    expect(callsTo(calls, 'answerCallbackQuery').map((call) => call.payload)).toEqual([
      { callback_query_id: 'cq-71', text: refusal, show_alert: true },
    ]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual([]);
  });

  it('the whole path under INVITED: refused by /start, prompted by the gate, joins, presses — refused again, never welcomed', async () => {
    let status = 'left';
    const { calls, admin } = await runBot(
      panelPolicy({ accessMode: 'INVITED' }),
      () => member(status),
      [startUpdate(73), textUpdate(74, 'hi'), { run: () => (status = 'member') }, checkChannelUpdate(75)],
      { userExists: false },
    );

    expect(admin.user.bootstrap).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toEqual(['ru:access_mode.invited_no_code', 'ru:channel.required']);
    expect(toasts(calls)).toEqual(['ru:access_mode.invited_no_code']);
  });

  it('lets a user rezeis has an account for through to the welcome screen, under either mode', async () => {
    for (const accessMode of ['INVITED', 'REG_BLOCKED']) {
      resetChannelGateMemory();
      resetChannelJoinPromptMemory();
      setPolicyCache(null);
      const { calls } = await runBot(panelPolicy({ accessMode }), () => member('member'), [checkChannelUpdate(76)]);

      expect(toasts(calls), accessMode).toEqual(['ru:channel.verified']);
      expect(welcomeCount(calls), accessMode).toBe(1);
    }
  });
});

describe('a Telegram that never answers', () => {
  const HANGING = (): BotApiAnswer => 'hang';

  it('does not hold the next user’s update: the first is let in when the gate client gives up, the next without asking', async () => {
    const { calls, reached, handledInMs } = await runBot(panelPolicy(), HANGING, [
      textUpdate(80, 'hello', USER_A),
      textUpdate(81, 'hello', USER_B),
    ]);

    expect(reached).toEqual([80, 81]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(handledInMs[0]).toBeLessThan(3_000);
    expect(handledInMs[1]).toBeLessThan(500);
  });

  it('/start asks through the gate’s client too', async () => {
    const { calls, handledInMs } = await runBot(panelPolicy(), HANGING, [startUpdate(82)]);

    expect(handledInMs[0]).toBeLessThan(3_000);
    expect(welcomeCount(calls)).toBe(1);
  });

  it('«Я подписался» asks through the gate’s client too', async () => {
    const { calls, handledInMs } = await runBot(panelPolicy(), HANGING, [checkChannelUpdate(83)]);

    expect(handledInMs[0]).toBeLessThan(3_000);
    expect(toasts(calls)).toEqual(['ru:channel.verified']);
  });

  it('the quest verify button’s own check asks through the gate’s client too', async () => {
    let hang = false;
    const { calls, handledInMs } = await runBot(
      panelPolicy(),
      (payload) => (hang && payload.chat_id === '@rezeis_quest' ? 'hang' : member('member')),
      [{ run: () => (hang = true) }, callbackUpdate(84, `quest_channel:${QUEST_ID}`)],
    );

    expect(handledInMs[0]).toBeLessThan(3_000);
    expect(toasts(calls)).toEqual(['ru:quests.channel.retry']);
  });
});

describe('channel gate in front of every update — verdicts that let the update on', () => {
  it('a subscriber reaches the page', async () => {
    const { calls, reached } = await runBot(panelPolicy(), () => member('member'), [
      callbackUpdate(90, 'back_to_menu'),
    ]);

    expect(reached).toEqual([90]);
    expect(toasts(calls)).toEqual([undefined]);
    expect(sentTexts(calls)).toEqual(['ru:menu.choose_action']);
  });

  it('with «Перепроверять подписку» on, two quick updates cost one getChatMember; past the minute, another', async () => {
    useClock();
    const { calls, reached } = await runBot(panelPolicy({ channelRecheck: true }), () => member('member'), [
      callbackUpdate(91, 'back_to_menu'),
      textUpdate(92, 'hello'),
      { advanceMs: 60_000 },
      callbackUpdate(93, 'back_to_menu'),
    ]);

    expect(reached).toEqual([91, 92, 93]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
  });

  it('with «Перепроверять подписку» on, a user who left is stopped at the first update after the minute', async () => {
    useClock();
    let status = 'member';
    const { reached, calls } = await runBot(panelPolicy({ channelRecheck: true }), () => member(status), [
      callbackUpdate(94, 'back_to_menu'),
      { run: () => (status = 'left') },
      { advanceMs: 59_999 },
      callbackUpdate(95, 'back_to_menu'),
      { advanceMs: 1 },
      callbackUpdate(96, 'back_to_menu'),
    ]);

    expect(reached).toEqual([94, 95]);
    expect(toasts(calls).at(-1)).toBe('ru:channel.not_subscribed');
  });

  it('with «Перепроверять подписку» off, a pass outlives a restart through the shared store', async () => {
    const redis = new FakeRedis();
    const first = await runBot(panelPolicy({ channelRecheck: false }), () => member('member'), [callbackUpdate(97, 'back_to_menu')], {
      store: new RedisChannelGateStore({ redis: redis.asRedis() }),
    });
    expect(callsTo(first.calls, 'getChatMember')).toHaveLength(1);
    // The pass was written in the background, and `runBot` waited for it.
    expect(redis.keys()).toEqual([`reiwa:channel-gate:v1:pass:@rezeis_news:${USER_A.id}`]);

    // A new process: nothing in memory, the same Redis. The user has since left —
    // and «проверка только при первом входе» means nobody asks.
    resetChannelGateMemory();
    const second = await runBot(panelPolicy({ channelRecheck: false }), () => member('left'), [callbackUpdate(98, 'back_to_menu')], {
      store: new RedisChannelGateStore({ redis: redis.asRedis() }),
    });
    expect(second.reached).toEqual([98]);
    expect(callsTo(second.calls, 'getChatMember')).toHaveLength(0);
  });

  it('/start asks Telegram every time, but not twice within 2 seconds: a subscriber tapping it quickly costs one call', async () => {
    useClock();
    const { calls } = await runBot(panelPolicy({ channelRecheck: true }), () => member('member'), [
      startUpdate(99),
      { advanceMs: 1_999 },
      startUpdate(100),
      { advanceMs: 1 },
      startUpdate(221),
    ]);

    // Not the minute an ordinary update trusts a pass for: /start is a fresh door.
    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
    expect(welcomeCount(calls)).toBe(3);
  });

  it('with «Перепроверять подписку» off, a store that never finishes a write does not hold the update', async () => {
    const neverFinishes: ChannelGateStore = {
      hasPass: async () => false,
      recordPass: () => new Promise<void>(() => undefined),
      forgetPass: () => new Promise<void>(() => undefined),
      claimAlert: () => new Promise<boolean>(() => undefined),
    };
    const off = await runBot(
      panelPolicy({ channelRecheck: false }),
      () => member('member'),
      [callbackUpdate(222, 'back_to_menu'), startUpdate(223)],
      { store: neverFinishes, settle: false },
    );
    expect(off.reached).toEqual([222, 223]);
    expect(Math.max(...off.handledInMs)).toBeLessThan(1_000);

    // …nor under ON, where "not subscribed" forgets the pass in the store. The
    // policy cache is a singleton too: without the reset this run read OFF again.
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
    setPolicyCache(null);
    const forgets = vi.spyOn(neverFinishes, 'forgetPass');
    const on = await runBot(panelPolicy({ channelRecheck: true }), () => member('left'), [textUpdate(224, 'hello')], {
      store: neverFinishes,
      settle: false,
    });
    expect(forgets).toHaveBeenCalledTimes(1);
    expect(sentTexts(on.calls)).toEqual(['ru:channel.required']);
    expect(Math.max(...on.handledInMs)).toBeLessThan(1_000);
  });

  it('«Перепроверять подписку» OFF: both fresh doors — «Я подписался» and /start — honour a pass, remembered or only in the store', async () => {
    const redis = new FakeRedis();
    // Another process let USER_B in: the pass is in the store only.
    await new RedisChannelGateStore({ redis: redis.asRedis() }).recordPass('@rezeis_news', USER_B.id, YEAR_MS);
    let statusOfA = 'member';
    const { calls, reached } = await runBot(
      panelPolicy({ channelRecheck: false }),
      (payload) => member(payload.user_id === USER_A.id ? statusOfA : 'left'),
      [
        // USER_A's first entry: asked once, let in, remembered.
        textUpdate(240, 'hello', USER_A),
        // Both have left the channel since.
        { run: () => (statusOfA = 'left') },
        checkChannelUpdate(241),
        startUpdate(242, USER_A),
        callbackUpdate(243, 'check_channel', USER_B),
        startUpdate(244, USER_B),
      ],
      { store: new RedisChannelGateStore({ redis: redis.asRedis() }) },
    );

    // «Проверка только при первом входе»: nobody is asked again, at either door.
    expect(callsTo(calls, 'getChatMember').map((call) => call.payload.user_id)).toEqual([USER_A.id]);
    expect(reached).toEqual([240, 241, 242, 243, 244]);
    expect(toasts(calls)).toEqual(['ru:channel.verified', 'ru:channel.verified']);
    expect(promptPayloads(calls)).toEqual([]);
    expect(welcomeCount(calls)).toBe(4);
  });

  it('«Перепроверять подписку» ON: both fresh doors ask past a pass, a "not subscribed" at either forgets the store pass — and switching to OFF brings neither back', async () => {
    const redis = new FakeRedis();
    const seed = new RedisChannelGateStore({ redis: redis.asRedis() });
    // Both were let in while the setting was OFF.
    await seed.recordPass('@rezeis_news', USER_A.id, YEAR_MS);
    await seed.recordPass('@rezeis_news', USER_B.id, YEAR_MS);
    let status = 'member';
    const on = await runBot(
      panelPolicy({ channelRecheck: true }),
      () => member(status),
      [
        // Ordinary updates: asked, a pass trusted for a minute.
        callbackUpdate(245, 'back_to_menu', USER_A),
        callbackUpdate(246, 'back_to_menu', USER_B),
        { run: () => (status = 'left') },
        // Inside that minute, at the fresh doors: asked anyway.
        checkChannelUpdate(247),
        startUpdate(248, USER_B),
      ],
      { store: new RedisChannelGateStore({ redis: redis.asRedis() }) },
    );

    expect(callsTo(on.calls, 'getChatMember')).toHaveLength(4);
    expect(toasts(on.calls)).toEqual([undefined, undefined, 'ru:channel.not_subscribed']);
    expect(promptPayloads(on.calls)).toHaveLength(1);
    expect(redis.keys()).toEqual([]);

    // The operator switches the setting OFF: neither old pass lets them back in.
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
    setPolicyCache(null);
    const off = await runBot(
      panelPolicy({ channelRecheck: false }),
      () => member('left'),
      [callbackUpdate(249, 'back_to_menu', USER_A), callbackUpdate(250, 'back_to_menu', USER_B)],
      { store: new RedisChannelGateStore({ redis: redis.asRedis() }) },
    );
    expect(off.reached).toEqual([]);
    expect(callsTo(off.calls, 'getChatMember')).toHaveLength(2);
  });

  it('«Я подписался» asks Telegram even right after a pass', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('member'), [
      callbackUpdate(101, 'back_to_menu'),
      checkChannelUpdate(102),
    ]);

    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
    expect(toasts(calls)).toEqual([undefined, 'ru:channel.verified']);
  });

  it('«Я подписался» that finds the user gone makes the next button stop them, remembered pass or not', async () => {
    let status = 'member';
    const { calls, reached } = await runBot(panelPolicy(), () => member(status), [
      callbackUpdate(103, 'back_to_menu'),
      { run: () => (status = 'left') },
      checkChannelUpdate(104),
      callbackUpdate(105, 'back_to_menu'),
    ]);

    // Update 105 comes well inside the minute update 103's pass is trusted for.
    // Only the fresh "not subscribed" at 104 forgetting that pass stops it — and
    // it is itself remembered, so 105 costs no call.
    expect(reached).toEqual([103, 104]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
    expect(sentTexts(calls)).toEqual(['ru:menu.choose_action', 'ru:channel.not_subscribed', 'ru:channel.required']);
  });

  it('a user the gate cannot check is let through, and the operator told once', async () => {
    const { calls, reached, reportError } = await runBot(
      panelPolicy({ channelId: CHANNEL_ID }),
      () => ({ ok: false, error_code: 400, description: 'Bad Request: member list is inaccessible' }),
      [callbackUpdate(106, 'back_to_menu'), textUpdate(107, 'hello')],
    );

    expect(reached).toEqual([106, 107]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(1);
    expect(sentTexts(calls)).toEqual(['ru:menu.choose_action']);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a platform policy rezeis does not serve lets updates through, logged once', async () => {
    const { calls, reached, warn } = await runBot(new Error('connect ECONNREFUSED rezeis:8000'), () => member('left'), [
      callbackUpdate(108, 'back_to_menu'),
      callbackUpdate(109, 'back_to_menu'),
    ]);

    expect(reached).toEqual([108, 109]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual(['ru:menu.choose_action', 'ru:menu.choose_action']);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('platform policy'))).toHaveLength(1);
  });

  it('a platform policy rezeis answers with null lets updates through instead of failing every update, logged once', async () => {
    const { calls, reached, warn, admin } = await runBot(async () => null, () => member('left'), [
      callbackUpdate(225, 'back_to_menu'),
      textUpdate(226, 'hello'),
    ]);

    expect(reached).toEqual([225, 226]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(sentTexts(calls)).toEqual(['ru:menu.choose_action']);
    // `PolicyCache` reads the null as a failed read, not as the policy: rezeis is
    // asked again, and the second failure in a row holds the stand-in instead of
    // asking on every update. The middleware says so once, as for a panel that
    // does not answer at all.
    expect(admin.system.getPlatformPolicy).toHaveBeenCalledTimes(2);
    expect(
      warn.mock.calls.filter((args) => String(args[1]).includes('did not answer with a platform policy')),
    ).toHaveLength(1);
  });

  it('a policy cache that hands out something that is not a policy lets updates through too, logged once', async () => {
    setPolicyCache(Object.assign(Object.create(PolicyCache.prototype) as PolicyCache, { get: async () => null }));
    const { calls, reached, warn } = await runBot(panelPolicy(), () => member('left'), [
      callbackUpdate(227, 'back_to_menu'),
      textUpdate(228, 'hello'),
    ]);

    expect(reached).toEqual([227, 228]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('not a policy'))).toHaveLength(1);
  });

  it('says so again an hour later: once an hour, not once a process', async () => {
    useClock();
    const { reached, warn } = await runBot(new Error('connect ECONNREFUSED rezeis:8000'), () => member('left'), [
      callbackUpdate(110, 'back_to_menu'),
      { advanceMs: 60 * 60 * 1000 - 1 },
      callbackUpdate(111, 'back_to_menu'),
      { advanceMs: 1 },
      callbackUpdate(112, 'back_to_menu'),
    ]);

    expect(reached).toEqual([110, 111, 112]);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('platform policy'))).toHaveLength(2);
  });

  it('a policy cache that throws lets updates through too, logged once', async () => {
    setPolicyCache(
      Object.assign(Object.create(PolicyCache.prototype) as PolicyCache, {
        get: async () => {
          throw new Error('policy cache broke');
        },
      }),
    );
    const { reached, warn } = await runBot(panelPolicy(), () => member('left'), [
      callbackUpdate(113, 'back_to_menu'),
      callbackUpdate(114, 'back_to_menu'),
    ]);

    expect(reached).toEqual([113, 114]);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('platform policy'))).toHaveLength(1);
  });

  it('no admin client: no policy to gate on, updates pass, logged once', async () => {
    const { calls, reached, warn } = await runBot(
      panelPolicy(),
      () => member('left'),
      [callbackUpdate(115, 'back_to_menu'), callbackUpdate(116, 'back_to_menu')],
      { adminClient: null },
    );

    expect(reached).toEqual([115, 116]);
    expect(callsTo(calls, 'getChatMember')).toHaveLength(0);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes('no admin client'))).toHaveLength(1);
  });
});

describe('the platform policy cache answering stale while it refreshes', () => {
  it('a stale policy still gates at once while the panel hangs, and a refreshed one is used as soon as it lands', async () => {
    useClock();
    let panel: () => Promise<unknown> = async () => panelPolicy();
    const { calls, reached, admin } = await runBot(() => panel(), () => member('left'), [
      textUpdate(120, 'hello', USER_A),
      { advanceMs: 61_000 },
      { run: () => (panel = () => new Promise(() => undefined)) },
      // Stale policy, panel hanging: decided at once, with the gate still on.
      textUpdate(121, 'hello', USER_B),
    ]);

    expect(reached).toEqual([]);
    expect(sentTexts(calls)).toEqual(['ru:channel.required', 'ru:channel.required']);
    expect(admin.system.getPlatformPolicy).toHaveBeenCalledTimes(2);

    // The other half: the operator switched the gate off, and the refresh brought it in.
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
    setPolicyCache(null);
    let version = 1;
    const switched = await runBot(
      async () => (version === 1 ? panelPolicy() : panelPolicy({ channelRequired: false })),
      () => member('left'),
      [
        textUpdate(122, 'hello', USER_A),
        { advanceMs: 61_000 },
        { run: () => (version = 2) },
        textUpdate(123, 'hello', USER_B),
        textUpdate(124, 'hello again', USER_B),
      ],
    );
    expect(switched.reached).toEqual([124]);
  });
});

describe('the join prompt — one message, whichever door the user came through', () => {
  it('is, from the middleware, exactly the prompt /start sent before the gate moved', async () => {
    const { calls } = await runBot(panelPolicy(), () => member('left'), [
      startUpdate(130, USER_A),
      callbackUpdate(131, 'back_to_menu', USER_B),
      textUpdate(132, 'hello', USER_B),
    ]);

    // The text message is inside USER_B's prompt interval: two prompts, not three.
    expect(promptPayloads(calls)).toEqual([JOIN_PROMPT, JOIN_PROMPT]);
  });

  it('resolves operator emoji tokens on both buttons the same way on both doors', async () => {
    const operatorCopy: Readonly<Record<string, string>> = {
      'channel.join_button': ':megaphone: Перейти в канал',
      'channel.check_button': ':tick: Я подписался :sparkle:',
    };
    const translator: TranslatorPort = {
      t: (key, lang) => operatorCopy[key] ?? `${lang}:${key}`,
      resolveButtonLabel: (_id, fallback) => fallback,
    };
    const config: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      customEmojis: {
        megaphone: { id: '5300', fallback: '📢' },
        tick: { id: '5400', fallback: '✅' },
        sparkle: { id: '5900', fallback: '✨' },
      },
      botEmojiOwnerHasPremium: true,
    };
    const { calls } = await runBot(
      panelPolicy(),
      () => member('left'),
      [startUpdate(133, USER_A), callbackUpdate(134, 'back_to_menu', USER_B)],
      { translator, config },
    );

    const expected = {
      text: 'ru:channel.required',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Перейти в канал', icon_custom_emoji_id: '5300', url: 'https://t.me/rezeis_news' }],
          [{ text: 'Я подписался ✨', icon_custom_emoji_id: '5400', callback_data: 'check_channel' }],
        ],
      },
    };
    expect(promptPayloads(calls)).toEqual([expected, expected]);
  });
});

/**
 * Read through the TypeScript parser, not a regex over the text: a commented-out
 * line is not code, and a pin that a comment satisfies pins nothing.
 */
describe('src/bot/main.ts — the gate is wired the way these specs wire it', () => {
  const main = ts.createSourceFile(
    'main.ts',
    readFileSync(new URL('../../src/bot/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  function nodesOf(root: ts.Node): ts.Node[] {
    const found: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  }

  const textOf = (node: ts.Node): string => node.getText(main);
  const calls = nodesOf(main).filter(ts.isCallExpression);

  /** The `bot.use(<callee>(…))` statement, when there is exactly one. */
  function botUseOf(callee: string): ts.CallExpression {
    const found = calls.filter((call) => {
      const [argument] = call.arguments;
      return (
        textOf(call.expression) === 'bot.use' &&
        argument !== undefined &&
        ts.isCallExpression(argument) &&
        textOf(argument.expression) === callee
      );
    });
    expect(found, `bot.use(${callee}(…))`).toHaveLength(1);
    return found[0];
  }

  function declared(name: string): ts.Expression | undefined {
    return nodesOf(main)
      .filter(ts.isVariableDeclaration)
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)?.initializer;
  }

  /** `{ a, b: c }` → `{ a: 'a', b: 'c' }`. */
  function fieldsOf(literal: ts.ObjectLiteralExpression): Record<string, string> {
    return Object.fromEntries(
      literal.properties.map((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return [property.name.text, property.name.text];
        if (ts.isPropertyAssignment(property)) return [textOf(property.name), textOf(property.initializer)];
        return [textOf(property), '<not a plain property>'];
      }),
    );
  }

  it('registers the gate after the session and locale middlewares and before every page, in the same block', () => {
    const sessionUse = botUseOf('session');
    const localeUse = botUseOf('createLocaleDetectMiddleware');
    const gateUse = botUseOf('createChannelGateMiddleware');
    const gateMiddleware = gateUse.arguments[0] as ts.CallExpression;
    const pages = calls.filter(
      (call) => /^register[A-Za-z]+Page$/.test(textOf(call.expression)) && call.arguments[0] !== undefined,
    );

    expect(gateMiddleware.arguments.map(textOf)).toEqual(['pageDeps']);
    expect(localeUse.getStart(), 'locale after session').toBeGreaterThan(sessionUse.getStart());
    expect(gateUse.getStart(), 'the gate after locale').toBeGreaterThan(localeUse.getStart());
    expect(pages.length, 'page registrars').toBeGreaterThan(10);
    for (const page of pages) {
      expect(page.getStart(), `${textOf(page.expression)} after the gate`).toBeGreaterThan(gateUse.getStart());
      expect(page.arguments.map(textOf), textOf(page.expression)).toEqual(['bot', 'pageDeps']);
    }
    // Unconditional: the gate's statement sits in the same block as the locale middleware's.
    expect(ts.isExpressionStatement(gateUse.parent)).toBe(true);
    expect(gateUse.parent.parent).toBe(localeUse.parent.parent);
  });

  it('hands every page the gate built from the bot’s token, API root, REDIS_URL and logger', () => {
    const pageDeps = declared('pageDeps');
    expect(pageDeps !== undefined && ts.isObjectLiteralExpression(pageDeps), 'const pageDeps = { … }').toBe(true);
    expect(fieldsOf(pageDeps as ts.ObjectLiteralExpression).channelGate).toBe('channelGate');

    const gate = declared('channelGate');
    expect(gate !== undefined && ts.isCallExpression(gate) && textOf(gate.expression)).toBe('createBotChannelGate');
    const [options] = (gate as ts.CallExpression).arguments;
    expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
    expect(fieldsOf(options as ts.ObjectLiteralExpression)).toEqual({
      token: 'config.BOT_TOKEN',
      apiRoot: 'config.TELEGRAM_BOT_API_ROOT',
      redisUrl: 'config.REDIS_URL',
      logger: 'logger',
    });
  });
});
