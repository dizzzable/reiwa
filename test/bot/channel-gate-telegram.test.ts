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
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChannelGateMemory } from '../../src/bot/lib/channel-gate.js';
import { registerMenuPage } from '../../src/bot/pages/menu.js';
import { registerStartPage } from '../../src/bot/pages/start.js';
import type { BotContext, PageDeps } from '../../src/bot/pages/types.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';
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

type BotApiAnswer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error_code: number; readonly description: string };

interface BotApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const USER_A = { id: 4242, is_bot: false, first_name: 'Ann', language_code: 'ru' } as const;
const USER_B = { id: 4343, is_bot: false, first_name: 'Bob', language_code: 'ru' } as const;

function member(status: string, extra: Record<string, unknown> = {}): BotApiAnswer {
  return { ok: true, result: { status, user: USER_A, ...extra } };
}

/** A local "Bot API": records each call and answers `getChatMember` as told. */
async function localBotApi(
  getChatMember: (payload: Record<string, unknown>) => BotApiAnswer,
): Promise<{ readonly apiRoot: string; readonly calls: BotApiCall[]; readonly close: () => Promise<void> }> {
  const calls: BotApiCall[] = [];
  let nextMessageId = 100;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = (body.length > 0 ? JSON.parse(body) : {}) as Record<string, unknown>;
      calls.push({ method, payload });
      let answer: BotApiAnswer = { ok: true, result: true };
      if (method === 'getChatMember') answer = getChatMember(payload);
      if (method === 'sendMessage') {
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
      res.writeHead(answer.ok ? 200 : answer.error_code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startUpdate(updateId: number, user: typeof USER_A | typeof USER_B = USER_A): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: user.id, type: 'private', first_name: user.first_name },
      from: user,
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  } as Update;
}

function checkChannelUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: USER_A,
      chat_instance: 'ci-1',
      data: 'check_channel',
      message: {
        message_id: 50,
        date: 0,
        chat: { id: USER_A.id, type: 'private', first_name: USER_A.first_name },
        from: BOT_INFO,
        text: 'ru:channel.required',
      },
    },
  } as Update;
}

async function runBot(
  policy: Record<string, unknown>,
  getChatMember: (payload: Record<string, unknown>) => BotApiAnswer,
  updates: readonly Update[],
): Promise<{
  readonly calls: BotApiCall[];
  readonly reportError: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
}> {
  const botApi = await localBotApi(getChatMember);
  const reportError = vi.fn().mockResolvedValue({ ok: true });
  const adminClient = {
    system: {
      // What the admin transport hands back: `JSON.parse` of the body rezeis wrote.
      getPlatformPolicy: vi.fn(async () => JSON.parse(JSON.stringify(policy)) as unknown),
      reportError,
    },
    user: { bootstrap: vi.fn(async () => null) },
    subscription: { getAll: vi.fn(async () => ({ subscriptions: [] })) },
    webAuth: { issueBotSigninToken: vi.fn(async () => ({ token: 'signin-token' })) },
    trial: { getEligibility: vi.fn(async () => null) },
  };
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
    adminClient: adminClient as unknown as PageDeps['adminClient'],
    translator: buildPassthroughTranslator(),
    userLocale: {
      getSync: (id) => locales.get(id) ?? 'ru',
      setSync: (id, lang) => {
        locales.set(id, lang);
      },
      hasSync: (id) => locales.has(id),
    },
    getConfig: async () => DEFAULT_BOT_CONFIG,
    urls: { publicWebUrl: null, miniAppUrl: null, rezeisAdminUrl: null },
    logger: logger as unknown as PageDeps['logger'],
  };
  const bot = new Bot<BotContext>(TOKEN, { botInfo: BOT_INFO, client: { apiRoot: botApi.apiRoot } });
  registerMenuPage(bot, deps);
  registerStartPage(bot, deps);
  try {
    for (const update of updates) await bot.handleUpdate(update);
  } finally {
    await botApi.close();
  }
  return { calls: botApi.calls, reportError, warn };
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

beforeEach(() => {
  // Both are process singletons; a spec must not inherit the previous one's.
  setPolicyCache(null);
  resetChannelGateMemory();
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
    expect(callsTo(calls, 'answerCallbackQuery').map((call) => call.payload.text)).toEqual([undefined]);
    expect(sentTexts(calls)).toEqual(['ru:channel.not_subscribed']);
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
  it('bot is not a channel administrator: Telegram refuses, both users get in, one report names the fix', async () => {
    const policy = panelPolicy({ channelId: CHANNEL_ID });
    const { calls, reportError, warn } = await runBot(
      policy,
      () => ({ ok: false, error_code: 400, description: 'Bad Request: member list is inaccessible' }),
      [startUpdate(6, USER_A), startUpdate(7, USER_B)],
    );

    // Fail open: a Telegram refusal never locks a (possibly paying) user out.
    expect(callsTo(calls, 'getChatMember')).toHaveLength(2);
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
