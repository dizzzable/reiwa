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
 * like it, and every path answers the callback query exactly once.
 *
 * Data that is neither — a button on an old message the operator has since
 * removed or changed, a screen the flow no longer has — used to reach nothing:
 * the button spun and the user saw silence. It gets «Меню обновилось» and the
 * current main menu in place of that message now (owner's decision,
 * 24.09.2026; `pages/stale-button.ts`), from the very last handler — and not
 * past the channel gate, the RESTRICTED alert or the own-chat rule.
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
  registerStaleButtonPage,
  registerStartPage,
  type PageRegistrar,
} from '../../src/bot/pages/index.js';
import {
  CALLBACK_ANSWER_MAX_CHARS,
  fitCallbackAnswer,
  MENU_SENT_ANEW_WINDOW_MS,
  resetMenuSentAnewMemory,
} from '../../src/bot/pages/start.js';
import type { BotContext, BotSession, PageDeps } from '../../src/bot/pages/types.js';
import { buildMainKeyboard } from '../../src/bot/widgets/main-keyboard.js';
import { setLegalDocumentsCache } from '../../src/infrastructure/admin-client/legal-documents-cache.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';
import type { BotConfig, BotScreen } from '../../src/infrastructure/bot-config/types.js';
import { EN_PACK, RU_PACK } from '../../src/infrastructure/i18n/packs/index.js';
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
  ['registerStaleButtonPage', registerStaleButtonPage],
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

/** A Bot API refusal, as Telegram words it. */
interface Refusal {
  readonly error_code: number;
  readonly description: string;
}

interface PressOptions {
  /** The panel, where the press needs one: the platform policy for the gate and «В меню». */
  readonly adminClient?: Record<string, unknown>;
  /** The chat the pressed message is in; the user's own private chat by default. */
  readonly chat?: { readonly id: number; readonly type: string; readonly title?: string };
  /** Bot API methods Telegram refuses, by name. */
  readonly refuse?: Readonly<Record<string, Refusal>>;
  /** Answers per Bot API method other than a refusal (`getChatMember`). */
  readonly answers?: Readonly<Record<string, unknown>>;
  /** Where the calls are recorded as they are made, for a test that looks before the press is over. */
  readonly calls?: ApiCall[];
  /** More of the pressed message: a photo, a business connection. */
  readonly messageExtra?: Record<string, unknown>;
  /** The texts, when a case needs an operator's own (the passthrough by default). */
  readonly translator?: PageDeps['translator'];
}

async function press(
  data: string,
  config: BotConfig,
  getConfig: () => Promise<BotConfig> = async () => config,
  options: PressOptions = {},
): Promise<ApiCall[]> {
  const calls: ApiCall[] = options.calls ?? [];
  const bot = new Bot<BotContext>('123456789:AAHfakeTokenForCallbackRoutingSpecs0', { botInfo: BOT_INFO });
  // Nothing leaves the process: every Bot API call is recorded and answered here.
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const refusal = options.refuse?.[method];
    if (refusal !== undefined) return { ok: false, ...refusal } as never;
    const result =
      options.answers?.[method] ??
      (method === 'sendMessage'
        ? { message_id: 90, date: 0, chat: { id: USER.id, type: 'private', first_name: USER.first_name }, text: '' }
        : true);
    return { ok: true, result } as never;
  });
  const locales = new Map<number, string>();
  const deps: PageDeps = {
    adminClient: (options.adminClient ?? null) as PageDeps['adminClient'],
    translator: options.translator ?? buildPassthroughTranslator(),
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
        chat: options.chat ?? { id: USER.id, type: 'private', first_name: USER.first_name },
        from: BOT_INFO,
        text: 'an old menu',
        ...options.messageExtra,
      },
    },
  } as Update;
  await bot.handleUpdate(update);
  return calls;
}

const answersOf = (calls: readonly ApiCall[]): ApiCall[] => calls.filter((c) => c.method === 'answerCallbackQuery');
const sentText = (calls: readonly ApiCall[]): unknown[] =>
  calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.payload['text']);

/** «Меню обновилось» through the passthrough translator. */
const STALE_NOTICE = 'ru:menu.updated';
/** The first line of the welcome screen `DEFAULT_BOT_CONFIG` greets Ann with. */
const WELCOME = 'Привет, Ann!';

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
  // Every press here is on the same message (chat 4242, message 50).
  resetMenuSentAnewMemory();
});

describe('callback routing — every page, in main.ts order', () => {
  it('registers the pages in the order main.ts does', () => {
    // The routing below holds only for this order: the bare-shortId handler
    // must come after every handler whose data it could otherwise take, and the
    // stale-button answer after it — it takes whatever reaches it.
    const main = readFileSync(resolve(__dirname, '../../src/bot/main.ts'), 'utf8');
    const order = [...main.matchAll(/\b(register\w+Page)\(bot, pageDeps\)/g)].map((m) => m[1]);
    expect(order).toEqual(PAGES.map(([name]) => name));
    expect(order.at(-1)).toBe('registerStaleButtonPage');
    // …and no handler is registered after the last of them: none of grammY's
    // registering methods (`on`, `use`, `callbackQuery`, …) is called on `bot`.
    const registering = new Set(Object.getOwnPropertyNames(Composer.prototype).filter((n) => n !== 'constructor'));
    const last = main.indexOf('registerStaleButtonPage(bot, pageDeps)');
    expect(last).toBeGreaterThan(-1);
    const calledAfter = [...main.slice(last).matchAll(/\bbot\.(\w+)\(/g)].map((m) => m[1]);
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
    // Not swallowed by the stale-button answer registered after every page.
    expect(JSON.stringify(calls)).not.toContain(STALE_NOTICE);
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

  /** What a button the bot no longer knows gets: the toast, then the menu in place of that message. */
  function expectMenuUpdatedInPlace(calls: readonly ApiCall[]): void {
    expect(answersOf(calls).map((c) => c.payload)).toEqual([{ callback_query_id: 'cq-1', text: STALE_NOTICE }]);
    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toMatchObject({ chat_id: USER.id, message_id: 50 });
    expect(String(edits[0]?.payload['text'])).toContain(WELCOME);
    // No new message: the old one became the menu.
    expect(calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto')).toEqual([]);
    // The toast before the menu, so the spinner stops first.
    expect(calls.findIndex((c) => c.method === 'answerCallbackQuery')).toBeLessThan(
      calls.findIndex((c) => c.method === 'editMessageText'),
    );
  }

  it('a `screen:` button onto a screen that is not there: «Меню обновилось» and the menu in its place', async () => {
    const calls = await press('screen:gone1234', { ...DEFAULT_BOT_CONFIG, screens: [] });
    expectMenuUpdatedInPlace(calls);
    expect(JSON.stringify(calls)).not.toContain('screen.not_found');
  });

  it.each([
    ['a button id no page answers', 'nonsense'],
    ['a shortId of a screen the flow no longer has', 'promo42x'],
    // The WHOLE data is the shortId, or it is not a shortId: no prefix, no more.
    ['a prefix of a shortId', 'promo'],
    ['a shortId with more after it', 'promo42x:more'],
    ['a retired built-in button', 'subscription'],
  ])('%s: «Меню обновилось» and the menu in place of that message, answered once', async (_what, data) => {
    const config =
      data === 'promo42x'
        ? { ...DEFAULT_BOT_CONFIG, screens: [] }
        : { ...DEFAULT_BOT_CONFIG, screens: [screen('promo42x', 'promo', 'SCREEN promo42x')] };
    const calls = await press(data, config);
    expectMenuUpdatedInPlace(calls);
    expect(JSON.stringify(calls)).not.toContain('SCREEN ');
  });

  it('the menu is the one «В меню» draws: the same calls, but for the toast', async () => {
    const stale = await press('nonsense', DEFAULT_BOT_CONFIG);
    const back = await press('menu:main', DEFAULT_BOT_CONFIG);
    expect(stale.map((c) => c.method)).toEqual(back.map((c) => c.method));
    const withoutAnswers = (calls: readonly ApiCall[]): ApiCall[] => calls.filter((c) => c.method !== 'answerCallbackQuery');
    expect(withoutAnswers(stale)).toEqual(withoutAnswers(back));
    expect(answersOf(back).map((c) => c.payload['text'])).toEqual([undefined]);
  });

  it('a message Telegram will not edit any more: the menu as a new message', async () => {
    const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
      refuse: { editMessageText: { error_code: 400, description: 'Bad Request: message to edit not found' } },
    });
    expect(answersOf(calls).map((c) => c.payload['text'])).toEqual([STALE_NOTICE]);
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload['chat_id']).toBe(USER.id);
    expect(String(sent[0]?.payload['text'])).toContain(WELCOME);
  });

  it('a double tap — the same menu already there — sends nothing new', async () => {
    const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
      refuse: {
        editMessageText: {
          error_code: 400,
          description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
        },
      },
    });
    expect(answersOf(calls).map((c) => c.payload['text'])).toEqual([STALE_NOTICE]);
    expect(calls.filter((c) => c.method === 'sendMessage')).toEqual([]);
  });

  describe('a double tap on a message Telegram will not edit (review R2a-09)', () => {
    const UNEDITABLE = { editMessageText: { error_code: 400, description: 'Bad Request: message to edit not found' } };
    const sends = (calls: readonly ApiCall[]): ApiCall[] => calls.filter((c) => c.method === 'sendMessage');

    it('sends ONE new menu: the second press is answered and sends nothing — no second sign-in token', async () => {
      const first = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, { refuse: UNEDITABLE });
      const second = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, { refuse: UNEDITABLE });

      expect(sends(first)).toHaveLength(1);
      expect(String(sends(first)[0]?.payload['text'])).toContain(WELCOME);
      // The spinner stops, and that is all.
      expect(second.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    });

    it('«В меню» too — the same memory, the same message', async () => {
      await press('menu:main', DEFAULT_BOT_CONFIG, undefined, { refuse: UNEDITABLE });
      const second = await press('menu:main', DEFAULT_BOT_CONFIG, undefined, { refuse: UNEDITABLE });
      expect(second.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    });

    it('another message still gets its own menu, and this one again once the window is over', async () => {
      await press('nonsense', DEFAULT_BOT_CONFIG, undefined, { refuse: UNEDITABLE });
      const other = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
        refuse: UNEDITABLE,
        messageExtra: { message_id: 51 },
      });
      expect(sends(other)).toHaveLength(1);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + MENU_SENT_ANEW_WINDOW_MS);
      try {
        const later = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, { refuse: UNEDITABLE });
        expect(sends(later)).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe('an operator’s «Меню обновилось» Telegram would refuse (review R2a-08)', () => {
    // 3 flags (2 code points each) + 40 × «Меню обновилось, » (17) = 686 code points.
    const LONG = '🇷🇺🇷🇺🇷🇺' + 'Меню обновилось, '.repeat(40);
    const operatorTexts = (): PageDeps['translator'] => {
      const passthrough = buildPassthroughTranslator();
      return {
        t: (key, lang, vars) => (key === 'menu.updated' ? LONG : passthrough.t(key, lang, vars)),
        resolveButtonLabel: passthrough.resolveButtonLabel,
      };
    };

    it('is cut to Telegram’s 200 characters, counted as code points, and the menu is drawn', async () => {
      const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, { translator: operatorTexts() });
      const toast = String(answersOf(calls)[0]?.payload['text']);
      expect([...toast]).toHaveLength(CALLBACK_ANSWER_MAX_CHARS);
      expect(toast.startsWith('🇷🇺🇷🇺🇷🇺Меню обновилось')).toBe(true);
      expect(toast.endsWith('…')).toBe(true);
      expect(String(calls.find((c) => c.method === 'editMessageText')?.payload['text'])).toContain(WELCOME);
    });

    it('a toast Telegram refuses all the same: the spinner stops without it, and the menu is still drawn', async () => {
      const calls: ApiCall[] = [];
      const bot = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
        calls,
        refuse: { answerCallbackQuery: { error_code: 400, description: 'Bad Request: MESSAGE_TOO_LONG' } },
      });
      // Tried with the toast, then without it; then the menu, whatever the answers did.
      expect(answersOf(bot).map((c) => c.payload['text'])).toEqual([STALE_NOTICE, undefined]);
      expect(String(bot.find((c) => c.method === 'editMessageText')?.payload['text'])).toContain(WELCOME);
    });

    it('cuts at a whole character: a flag is never split in half', () => {
      const flags = '🇷🇺'.repeat(150); // 300 code points
      const cut = fitCallbackAnswer(flags);
      expect([...cut].length).toBeLessThanOrEqual(CALLBACK_ANSWER_MAX_CHARS);
      expect(cut).toBe(`${'🇷🇺'.repeat(99)}…`);
      // A text that fits is left alone, emoji included.
      expect(fitCallbackAnswer('🔥 Меню обновилось')).toBe('🔥 Меню обновилось');
      expect(fitCallbackAnswer('x'.repeat(CALLBACK_ANSWER_MAX_CHARS))).toBe('x'.repeat(CALLBACK_ANSWER_MAX_CHARS));
    });
  });

  it('an old photo message Telegram will not edit: the menu, with its banner, as a new message', async () => {
    const withBanner: BotConfig = {
      ...DEFAULT_BOT_CONFIG,
      visual: { ...DEFAULT_BOT_CONFIG.visual, bannerUrl: 'https://cdn.example/welcome.jpg' },
    };
    const calls = await press('nonsense', withBanner, undefined, {
      messageExtra: { photo: [{ file_id: 'old-photo', file_unique_id: 'u1', width: 10, height: 10 }] },
      refuse: { editMessageMedia: { error_code: 400, description: "Bad Request: message can't be edited" } },
    });
    expect(answersOf(calls).map((c) => c.payload['text'])).toEqual([STALE_NOTICE]);
    expect(calls.filter((c) => c.method === 'editMessageMedia')).toHaveLength(1);
    const photos = calls.filter((c) => c.method === 'sendPhoto');
    expect(photos).toHaveLength(1);
    expect(photos[0]?.payload).toMatchObject({ chat_id: USER.id, photo: 'https://cdn.example/welcome.jpg' });
    expect(String(photos[0]?.payload['caption'])).toContain(WELCOME);
  });

  it('pressed in a group, it only stops the spinner: no menu there, and no sign-in token', async () => {
    const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
      chat: { id: -100777, type: 'supergroup', title: 'Operators' },
    });
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(answersOf(calls)[0]?.payload['text']).toBeUndefined();
  });

  // A business account's chat with a customer is the customer's private chat,
  // but the channel gate does not stand in it: the menu, with the customer's
  // sign-in token, must not be drawn there by a press the gate never saw.
  it('pressed in a business chat, it only stops the spinner', async () => {
    const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
      messageExtra: { business_connection_id: 'bc-1' },
    });
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(answersOf(calls)[0]?.payload['text']).toBeUndefined();
  });

  it('says «Меню обновилось» / «Menu updated» out of the box', () => {
    expect(RU_PACK['menu.updated']).toBe('Меню обновилось');
    expect(EN_PACK['menu.updated']).toBe('Menu updated');
  });

  it('under RESTRICTED: the refusal alert, no menu and no «Меню обновилось»', async () => {
    const adminClient = {
      system: { getPlatformPolicy: vi.fn().mockResolvedValue({ accessMode: 'RESTRICTED', channelRequired: false }) },
    };
    const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, { adminClient });
    expect(answersOf(calls).map((c) => c.payload)).toEqual([
      { callback_query_id: 'cq-1', text: 'ru:access_mode.restricted', show_alert: true },
    ]);
    expect(sentText(calls)).toEqual([]);
  });

  it('a non-subscriber behind «Канал обязателен»: the channel gate answers, not the menu', async () => {
    const adminClient = {
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({
          accessMode: 'PUBLIC',
          channelRequired: true,
          channelLink: 'https://t.me/rezeis_news',
          channelId: null,
          channelUsername: null,
          channelRecheck: true,
        }),
      },
    };
    const calls = await press('nonsense', DEFAULT_BOT_CONFIG, undefined, {
      adminClient,
      answers: { getChatMember: { status: 'left', user: USER } },
    });
    expect(calls.some((c) => c.method === 'getChatMember')).toBe(true);
    expect(answersOf(calls).map((c) => c.payload['text'])).toEqual(['ru:channel.not_subscribed']);
    expect(JSON.stringify(calls)).not.toContain(STALE_NOTICE);
    expect(JSON.stringify(calls)).not.toContain(WELCOME);
  });

  // Updates are handled one at a time: however long this press takes, every
  // update queued behind it waits as long. The config read that decides whether
  // the data is a shortId, and the one the toast's words are rendered with, each
  // wait a quarter second at most; the menu itself comes from the config the
  // cache gives — which never waits longer than a first load's budget
  // (`BotConfigCache.get()`).
  it('a press nothing claims gets its toast within half a second while the panel is slow, then the menu', async () => {
    vi.useFakeTimers();
    try {
      // One read, joined by every ask, as the cache does it; it lands after a second.
      const slow = new Promise<BotConfig>((resolve) => {
        setTimeout(() => resolve(DEFAULT_BOT_CONFIG), 1_000);
      });
      const live: ApiCall[] = [];
      const pressed = press('subscription', DEFAULT_BOT_CONFIG, () => slow, { calls: live });
      await vi.advanceTimersByTimeAsync(499);
      expect(answersOf(live)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // The toast's words as written: no config came within its budget.
      expect(answersOf(live).map((c) => c.payload['text'])).toEqual([STALE_NOTICE]);
      expect(sentText(live)).toEqual([]);
      await vi.advanceTimersByTimeAsync(500);
      await pressed;
      expect(sentText(live)).toHaveLength(1);
      expect(String(sentText(live)[0])).toContain(WELCOME);
    } finally {
      vi.useRealTimers();
    }
  });
});
