/**
 * Which handler answers which callback data — every page registered on a real
 * grammY `Bot`, in `main.ts` order, behind the same session and channel-gate
 * middleware, against an api that records every call and sends nothing.
 *
 * The panel's notification editor writes a button's callback data as free text,
 * and «Карта бота» has drawn two values as working since June that nothing in
 * the bot answered: `menu` and a bare screen shortId. The bot answers both now —
 * `menu` exactly as `menu:main`, a bare shortId exactly as `screen:<shortId>` —
 * and the second through a handler that runs only on data NOTHING else claims.
 * This file is the proof of that last part: every known callback still reaches
 * its own handler even when an operator screen's shortId is spelled exactly
 * like it, and every path answers the callback query exactly once. Data that is
 * neither keeps today's behaviour: nothing answers it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Bot, Composer, MemorySessionStorage, session } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChannelGateMemory } from '../../src/bot/lib/channel-gate.js';
import { createChannelGateMiddleware } from '../../src/bot/middleware/channel-gate.js';
import { resetChannelJoinPromptMemory } from '../../src/bot/pages/channel-join-prompt.js';
import {
  registerAiSupportPage,
  registerClosePage,
  registerDynamicScreenPage,
  registerHelpCallbackPage,
  registerHelpCommandPage,
  registerInlineSharePage,
  registerInvitePage,
  registerLangPage,
  registerMenuPage,
  registerPaymentsPage,
  registerPaySupportPage,
  registerQuestChannelPage,
  registerRulesPage,
  registerStartPage,
  type PageRegistrar,
} from '../../src/bot/pages/index.js';
import type { BotContext, BotSession, PageDeps } from '../../src/bot/pages/types.js';
import { buildMainKeyboard } from '../../src/bot/widgets/main-keyboard.js';
import { setLegalDocumentsCache } from '../../src/infrastructure/admin-client/legal-documents-cache.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';
import type { BotConfig, BotScreen } from '../../src/infrastructure/bot-config/types.js';
import { buildPassthroughTranslator } from './pages/helpers.js';

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

const USER = { id: 4242, is_bot: false, first_name: 'Ann', language_code: 'ru' } as const;
const QUEST = 'cabcdefghijklmnopqrst';

/** The pages, in the order `main.ts` registers them — pinned against its source below. */
const PAGES: ReadonlyArray<readonly [string, PageRegistrar]> = [
  ['registerLangPage', registerLangPage],
  ['registerInvitePage', registerInvitePage],
  ['registerInlineSharePage', registerInlineSharePage],
  ['registerRulesPage', registerRulesPage],
  ['registerHelpCallbackPage', registerHelpCallbackPage],
  ['registerHelpCommandPage', registerHelpCommandPage],
  ['registerPaySupportPage', registerPaySupportPage],
  ['registerPaymentsPage', registerPaymentsPage],
  ['registerMenuPage', registerMenuPage],
  ['registerStartPage', registerStartPage],
  ['registerQuestChannelPage', registerQuestChannelPage],
  ['registerClosePage', registerClosePage],
  ['registerAiSupportPage', registerAiSupportPage],
  ['registerDynamicScreenPage', registerDynamicScreenPage],
];

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

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

async function press(
  data: string,
  config: BotConfig,
  getConfig: () => Promise<BotConfig> = async () => config,
): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  const bot = new Bot<BotContext>('123456789:AAHfakeTokenForCallbackRoutingSpecs0', { botInfo: BOT_INFO });
  // Nothing leaves the process: every Bot API call is recorded and answered here.
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === 'sendMessage'
        ? { message_id: 90, date: 0, chat: { id: USER.id, type: 'private', first_name: USER.first_name }, text: '' }
        : true;
    return { ok: true, result } as never;
  });
  const locales = new Map<number, string>();
  const deps: PageDeps = {
    adminClient: null,
    translator: buildPassthroughTranslator(),
    userLocale: {
      getSync: (id) => locales.get(id) ?? 'ru',
      setSync: (id, lang) => {
        locales.set(id, lang);
      },
      hasSync: (id) => locales.has(id),
    },
    getConfig,
    urls: { publicWebUrl: null, miniAppUrl: null, rezeisAdminUrl: null },
  };
  bot.use(session({ initial: (): BotSession => ({}), storage: new MemorySessionStorage<BotSession>() }));
  bot.use(createChannelGateMiddleware(deps));
  for (const [, register] of PAGES) register(bot, deps);

  const update = {
    update_id: 1,
    callback_query: {
      id: 'cq-1',
      from: USER,
      chat_instance: 'ci-1',
      data,
      message: {
        message_id: 50,
        date: 0,
        chat: { id: USER.id, type: 'private', first_name: USER.first_name },
        from: BOT_INFO,
        text: 'an old menu',
      },
    },
  } as Update;
  await bot.handleUpdate(update);
  return calls;
}

const answersOf = (calls: readonly ApiCall[]): ApiCall[] => calls.filter((c) => c.method === 'answerCallbackQuery');
const sentText = (calls: readonly ApiCall[]): unknown[] =>
  calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.payload['text']);

/** What each known callback's OWN handler does, as seen at the Bot API. */
const KNOWN: ReadonlyArray<readonly [string, (calls: readonly ApiCall[]) => void]> = [
  ['help', (calls) => expect(sentText(calls)).toEqual(['ru:support.not_configured'])],
  ['rules', (calls) => expect(sentText(calls)).toEqual(['ru:rules.unavailable'])],
  ['invite', (calls) => expect(sentText(calls)).toEqual(['ru:referral.link_unavailable'])],
  ['back_to_menu', (calls) => expect(sentText(calls)).toEqual(['ru:menu.choose_action'])],
  ['close', (calls) => expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'deleteMessage'])],
  [
    'check_channel',
    (calls) => {
      expect(answersOf(calls)[0]?.payload['text']).toBe('ru:channel.verified');
      expect(String(sentText(calls)[0])).toContain('Привет, Ann!');
    },
  ],
  [
    `check_channel:q:${QUEST}`,
    (calls) => expect(answersOf(calls)[0]?.payload['text']).toBe('ru:channel.verified'),
  ],
  ['ai_support_exit', (calls) => expect(sentText(calls)).toEqual(['ru:ai_support.exited'])],
  ['menu:main', (calls) => expect(String(sentText(calls)[0])).toContain('Привет, Ann!')],
  ['lang:en', (calls) => expect(sentText(calls)).toEqual(['en:lang.changed(lang=en:lang.name.en)'])],
  [
    `quest_channel:${QUEST}`,
    (calls) => expect(answersOf(calls)[0]?.payload).toMatchObject({ text: 'ru:quests.channel.retry', show_alert: true }),
  ],
];

beforeEach(() => {
  setPolicyCache(null);
  setLegalDocumentsCache(null);
  resetChannelGateMemory();
  resetChannelJoinPromptMemory();
});

describe('callback routing — every page, in main.ts order', () => {
  it('registers the pages in the order main.ts does', () => {
    // The routing below holds only for this order: the bare-shortId handler
    // must come after every handler whose data it could otherwise take.
    const main = readFileSync(resolve(__dirname, '../../src/bot/main.ts'), 'utf8');
    const order = [...main.matchAll(/\b(register\w+Page)\(bot, pageDeps\)/g)].map((m) => m[1]);
    expect(order).toEqual(PAGES.map(([name]) => name));
    // …and no handler is registered after the last of them: none of grammY's
    // registering methods (`on`, `use`, `callbackQuery`, …) is called on `bot`.
    const registering = new Set(Object.getOwnPropertyNames(Composer.prototype).filter((n) => n !== 'constructor'));
    const after = main.slice(main.indexOf('registerDynamicScreenPage(bot, pageDeps)'));
    const calledAfter = [...after.matchAll(/\bbot\.(\w+)\(/g)].map((m) => m[1]);
    expect(calledAfter).toContain('catch');
    expect(calledAfter.filter((name) => registering.has(name))).toEqual([]);
  });

  // An operator screen whose shortId is spelled exactly like each known
  // callback, so a handler that took data it should not would render it.
  const shadowed: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    screens: [...KNOWN.map(([data]) => screen(data, `shadow ${data}`, `SCREEN ${data}`)), screen('menu', 'shadow menu', 'SCREEN menu')],
  };

  it.each(KNOWN)('%s still reaches its own handler, answered once, whatever screen shares its name', async (data, reachedOwn) => {
    const calls = await press(data, shadowed);
    expect(answersOf(calls)).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('SCREEN ');
    reachedOwn(calls);
  });

  it('`menu` is `menu:main`: the welcome screen in place, answered once', async () => {
    const calls = await press('menu', shadowed);
    expect(answersOf(calls)).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('SCREEN ');
    expect(calls.map((c) => c.method)).toEqual((await press('menu:main', shadowed)).map((c) => c.method));
    expect(String(sentText(calls)[0])).toContain('Привет, Ann!');
  });

  it('a bare shortId opens its screen exactly as `screen:<shortId>`, answered once', async () => {
    const config = { ...DEFAULT_BOT_CONFIG, screens: [screen('promo42x', 'promo', 'SCREEN promo42x')] };
    const bare = await press('promo42x', config);
    expect(answersOf(bare)).toHaveLength(1);
    expect(sentText(bare)).toEqual(['SCREEN promo42x']);
    expect(bare).toEqual(await press('screen:promo42x', config));
  });

  it('a bare shortId of a built-in screen reaches the built-in handler, answered once', async () => {
    const config = { ...DEFAULT_BOT_CONFIG, screens: [screen('rulz1234', 'rules', 'Правила {{rulesLink}}')] };
    const calls = await press('rulz1234', config);
    expect(answersOf(calls)).toHaveLength(1);
    // The rules handler's own template (no link without a panel): the placeholder filled, not raw.
    expect(sentText(calls)).toEqual(['Правила ']);
  });

  it.each([
    ['help', 'help1234'],
    ['rules', 'rulz1234'],
    ['invite', 'invt1234'],
  ])('a bare shortId of the %s screen does what that screen’s own button does', async (name, shortId) => {
    const config = { ...DEFAULT_BOT_CONFIG, screens: [screen(shortId, name, `${name} {{supportHandle}}{{rulesLink}}{{link}}`)] };
    const bare = await press(shortId, config);
    expect(answersOf(bare)).toHaveLength(1);
    expect(bare).toEqual(await press(`screen:${shortId}`, config));
    expect(bare).toEqual(await press(name, config));
  });

  // «Написать в поддержку» with no public support username falls back to a
  // callback. It sent the button's own ID, answered only when that ID was
  // `help`; whatever the ID, the press has to reach the help handler.
  it('a support button whose ID is not `help`, with no public username, is answered by the help handler', async () => {
    const kb = buildMainKeyboard({
      buttons: [
        {
          id: 'support',
          emoji: '',
          label: 'Поддержка',
          visible: true,
          order: 0,
          style: 'default',
          onePerRow: false,
          actionType: 'support_url',
          actionTarget: null,
        },
      ],
      miniAppUrl: null,
      publicWebUrl: null,
      lang: 'ru',
      translator: buildPassthroughTranslator(),
      supportUrl: null,
    });
    const data = (kb.inline_keyboard.flat()[0] as { callback_data?: string }).callback_data;
    expect(data).toBeDefined();
    const calls = await press(data!, DEFAULT_BOT_CONFIG);
    expect(answersOf(calls)).toHaveLength(1);
    expect(sentText(calls)).toEqual(['ru:support.not_configured']);
  });

  it('a `screen:` button onto a screen that is not there says so, answered once', async () => {
    const calls = await press('screen:gone1234', { ...DEFAULT_BOT_CONFIG, screens: [] });
    expect(answersOf(calls)).toHaveLength(1);
    expect(sentText(calls)).toEqual(['ru:screen.not_found']);
  });

  it('data that is neither a known callback nor a shortId stays unanswered, as before', async () => {
    const config = { ...DEFAULT_BOT_CONFIG, screens: [screen('promo42x', 'promo', 'SCREEN promo42x')] };
    expect(await press('nonsense', config)).toEqual([]);
    expect(await press('promo42x', { ...DEFAULT_BOT_CONFIG, screens: [] })).toEqual([]);
    // The WHOLE data is the shortId, or it is not a shortId: no prefix, no more.
    expect(await press('promo', config)).toEqual([]);
    expect(await press('promo42x:more', config)).toEqual([]);
  });

  // Updates are handled one at a time: however long this press takes, every
  // update queued behind it waits as long. A dead button used to cost nothing.
  it('a press nothing claims is let go within a quarter second while the config read hangs', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pressed = press('subscription', DEFAULT_BOT_CONFIG, () => new Promise<BotConfig>(() => undefined)).then(
        (calls) => {
          settled = true;
          return calls;
        },
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(settled).toBe(true);
      expect(await pressed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
