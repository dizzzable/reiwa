/**
 * Operator emoji tokens on inline-BUTTON captions, asserted at the call sites.
 *
 * `emoji-utils.test.ts` next door pins the renderers themselves. That is not
 * enough: `renderButtonLabel` / `renderSystemButton` were always correct, and
 * the defect was that whole screens never called them. A label built by handing
 * `translator.t(...)` straight to `kb.url(...)` / `kb.text(...)` renders the
 * operator's `:my_icon:` literally, and no unit test of the renderer can see
 * that.
 *
 * So these specs drive the real page handlers with an operator translator whose
 * copy carries `:slug:` tokens, and assert on the keyboard grammy actually
 * produced. Every one of them fails on a screen that skips the renderer, with
 * the raw token visible in the failure diff.
 *
 * Three keys get parity assertions rather than single-screen ones —
 * `help.contact_button`, `channel.*_button`, `back_to_menu`. Each is rendered
 * on two screens, and each used to be correct on one of them. That is the worst
 * shape this defect takes: the operator sees the emoji work, concludes it works,
 * and ships copy that breaks somewhere they did not look.
 *
 * Which renderer belongs where is part of the contract, so it is asserted too:
 * built-in system buttons (`back`, `help_contact`) must resolve the operator's
 * per-button icon from `systemButtonIcons` — that is the ONLY thing
 * `renderSystemButton` adds over `renderButtonLabel`. The fixtures give the
 * system icon a different id than the label-promoted one, so swapping the two
 * renderers fails loudly instead of looking right.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BotError } from 'grammy';
import type { Bot } from 'grammy';

import { registerHelpCommandPage } from '../../../src/bot/pages/help.js';
import { registerHelpCallbackPage } from '../../../src/bot/pages/help-callback.js';
import { registerInvitePage } from '../../../src/bot/pages/invite.js';
import { registerLangPage } from '../../../src/bot/pages/lang.js';
import { registerStartPage } from '../../../src/bot/pages/start.js';
import { createBotErrorHandler } from '../../../src/bot/lib/error-handler.js';
import {
  notifyDeveloperCredits,
  notifyOperatorBotStarted,
} from '../../../src/bot/lib/startup-notice.js';
import { UserNotFoundError } from '../../../src/core/errors/index.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import type { ErrorReporter } from '../../../src/infrastructure/error-reporter/index.js';
import type { LoggerPort } from '../../../src/application/ports/logger.port.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildFakeBot, buildFakeCtx } from '../../bot/pages/helpers.js';
import type { FakeBot } from '../../bot/pages/helpers.js';

// ── Test doubles ────────────────────────────────────────────────────────────
//
// The two conversions below are the only unsound ones in this file, and they
// exist once rather than once per test. `registerXPage` takes a real grammy
// `Bot` and the handlers take a real `Context`; the doubles record handler
// registrations and outbound calls, and a real Bot would need a live `getMe`
// before it dispatched anything. Every sibling spec under `test/bot/pages/`
// makes the same conversion inline — here it is named, so a reader sees one
// seam instead of two dozen.

type Registrar = (bot: Bot<BotContext>, deps: PageDeps) => void;

function register(registrar: Registrar, bot: FakeBot, deps: PageDeps): void {
  registrar(bot as unknown as Bot<BotContext>, deps);
}

function asCtx(ctx: object): BotContext {
  return ctx as unknown as BotContext;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The operator's emoji pack, as rezeis projects it into `customEmojis`.
 * Every entry has an id, so a LEADING token is promotable to the button's
 * `icon_custom_emoji_id` and a non-leading one falls back to the glyph.
 */
const PACK = {
  sos: { id: '5100', fallback: '🆘' },
  arrow: { id: '5200', fallback: '◀️' },
  megaphone: { id: '5300', fallback: '📢' },
  tick: { id: '5400', fallback: '✅' },
  phone: { id: '5500', fallback: '📱' },
  ru_flag: { id: '5600', fallback: '🇷🇺' },
  en_flag: { id: '5700', fallback: '🇬🇧' },
  cross: { id: '5800', fallback: '❌' },
  sparkle: { id: '5900', fallback: '✨' },
} as const;

/**
 * Operator copy, exactly as the panel's text editor stores it: an ordinary
 * i18n key whose value contains pack tokens. `help.contact_button` carries a
 * trailing token as well as a leading one so a single assertion covers both
 * halves of the contract — promotion of the leading token, glyph substitution
 * of the rest.
 */
const OPERATOR_COPY: Readonly<Record<string, string>> = {
  'help.contact_button': ':sos: Написать в поддержку :sparkle:',
  back_to_menu: ':arrow: В меню',
  'channel.join_button': ':megaphone: Перейти в канал',
  'channel.check_button': ':tick: Я подписался',
  'payment_return.open_app': ':phone: Открыть приложение',
  'lang.ru': ':ru_flag: Русский',
  'lang.en': ':en_flag: English',
  'bot_event.close': ':cross: Закрыть',
  'bot_event.credits.github': ':sparkle: GitHub',
  'bot_event.credits.telegram': ':sparkle: Telegram',
  'bot_event.credits.support': ':sparkle: Поддержать разработчика',
};

/** Rendered form each operator label must reach once tokens are resolved. */
const EXPECTED = {
  contact: { text: 'Написать в поддержку ✨', icon: '7001' },
  back: { text: 'В меню', icon: '7002' },
  join: { text: 'Перейти в канал', icon: '5300' },
  check: { text: 'Я подписался', icon: '5400' },
  openApp: { text: 'Открыть приложение', icon: '5500' },
  langRu: { text: 'Русский', icon: '5600' },
  langEn: { text: 'English', icon: '5700' },
  close: { text: 'Закрыть', icon: '5800' },
} as const;

function operatorTranslator(): TranslatorPort {
  return {
    t: (key) => OPERATOR_COPY[key] ?? key,
    resolveButtonLabel: (_id, fallback) => fallback,
  };
}

function operatorConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    ...DEFAULT_BOT_CONFIG,
    visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '@rezeis_support' },
    customEmojis: { ...PACK },
    botEmojiOwnerHasPremium: true,
    // The operator ALSO pinned icons on two built-in system buttons. These win
    // over the label-promoted token, which is what separates `renderSystemButton`
    // from `renderButtonLabel` — and the ids differ from the pack ids on purpose.
    systemButtonIcons: { help_contact: '7001', back: '7002' },
    ...over,
  };
}

interface Btn {
  readonly text?: string;
  readonly url?: string;
  readonly web_app?: { url: string };
  readonly callback_data?: string;
  readonly icon_custom_emoji_id?: string;
}

function buildOperatorDeps(over: {
  readonly config?: BotConfig;
  readonly miniAppUrl?: string | null;
  readonly publicWebUrl?: string | null;
  readonly adminClient?: unknown;
} = {}): PageDeps {
  const store = new Map<number, string>();
  return {
    adminClient: (over.adminClient ?? null) as PageDeps['adminClient'],
    translator: operatorTranslator(),
    userLocale: {
      getSync: (id: number) => store.get(id) ?? 'ru',
      setSync: (id: number, lang: string) => {
        store.set(id, lang);
      },
      hasSync: (id: number) => store.has(id),
    },
    getConfig: async () => over.config ?? operatorConfig(),
    urls: {
      publicWebUrl: over.publicWebUrl ?? null,
      miniAppUrl: over.miniAppUrl ?? null,
      rezeisAdminUrl: null,
    },
  };
}

function markup(call: unknown): Btn[] {
  const opts = call as { reply_markup?: { inline_keyboard?: Btn[][] } } | undefined;
  return (opts?.reply_markup?.inline_keyboard ?? []).flat();
}

/**
 * Every caption on the keyboard, so a failure shows the whole keyboard rather
 * than `undefined`. A screen that skips the renderer fails here with the raw
 * `:slug:` printed in the diff.
 */
function captions(buttons: readonly Btn[]): Array<string | undefined> {
  return buttons.map((b) => b.text);
}

function pick(buttons: readonly Btn[], text: string): Btn {
  const found = buttons.find((b) => b.text === text);
  if (found === undefined) {
    // Thrown rather than asserted so the return type narrows without a cast.
    // The keyboard goes into the message: on a screen that skips the renderer
    // the raw `:slug:` is right there in the failure.
    throw new Error(
      `no button captioned "${text}" — keyboard was ${JSON.stringify(captions(buttons))}`,
    );
  }
  return found;
}

// ── /help command vs. the `help` callback ───────────────────────────────────

async function renderHelpCommand(): Promise<Btn[]> {
  const bot = buildFakeBot();
  const deps = buildOperatorDeps();
  register(registerHelpCommandPage, bot, deps);
  const ctx = buildFakeCtx();
  const handler = bot.commandHandlers.get('help');
  expect(handler, 'the /help command must be registered').toBeDefined();
  await handler?.(asCtx(ctx));
  return markup(ctx.reply.mock.calls[0]?.[1]);
}

async function renderHelpCallback(): Promise<Btn[]> {
  const bot = buildFakeBot();
  const deps = buildOperatorDeps();
  register(registerHelpCallbackPage, bot, deps);
  const ctx = buildFakeCtx();
  await bot.callbackHandlers[0].handler(asCtx(ctx));
  return markup(ctx.editMessageText.mock.calls[0]?.[1]);
}

describe('help.contact_button — rendered on both help screens', () => {
  it('resolves the operator pack tokens on the /help COMMAND screen', async () => {
    const buttons = await renderHelpCommand();
    const contact = pick(buttons, EXPECTED.contact.text);
    expect(contact.icon_custom_emoji_id).toBe(EXPECTED.contact.icon);
    expect(captions(buttons).join(' ')).not.toContain(':sos:');
  });

  it('renders the same caption + icon on the command screen and the callback screen', async () => {
    const command = await renderHelpCommand();
    const callback = await renderHelpCallback();
    const fromCommand = pick(command, EXPECTED.contact.text);
    const fromCallback = pick(callback, EXPECTED.contact.text);
    expect(fromCommand.text).toBe(fromCallback.text);
    expect(fromCommand.icon_custom_emoji_id).toBe(fromCallback.icon_custom_emoji_id);
  });

  it('prefers the operator system-button icon over the label-promoted token', async () => {
    // `renderSystemButton` semantics: `systemButtonIcons.help_contact` wins.
    // Renders as `5100` (the pack id) if the site uses `renderButtonLabel`.
    const buttons = await renderHelpCommand();
    expect(pick(buttons, EXPECTED.contact.text).icon_custom_emoji_id).toBe('7001');
  });
});

describe('back_to_menu — rendered on every sub-screen', () => {
  it('resolves the operator pack token on the /help COMMAND screen', async () => {
    const buttons = await renderHelpCommand();
    const back = pick(buttons, EXPECTED.back.text);
    expect(back.callback_data).toBe('menu:main');
    expect(back.icon_custom_emoji_id).toBe(EXPECTED.back.icon);
  });

  it('resolves it on the /help fallback screen (no support handle configured)', async () => {
    const bot = buildFakeBot();
    const deps = buildOperatorDeps({
      config: operatorConfig({
        visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: '' },
      }),
    });
    register(registerHelpCommandPage, bot, deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')?.(asCtx(ctx));
    const back = pick(markup(ctx.reply.mock.calls[0]?.[1]), EXPECTED.back.text);
    expect(back.icon_custom_emoji_id).toBe(EXPECTED.back.icon);
  });

  it('resolves it on the invite screen early-returns, not only on the hubs', async () => {
    // Referrals off → the branch that builds its own one-button keyboard.
    const bot = buildFakeBot();
    const deps = buildOperatorDeps({
      config: operatorConfig({
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      }),
    });
    register(registerInvitePage, bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(asCtx(ctx));
    const buttons = markup(ctx.editMessageText.mock.calls[0]?.[1]);
    const back = pick(buttons, EXPECTED.back.text);
    expect(back.callback_data).toBe('menu:main');
    expect(back.icon_custom_emoji_id).toBe(EXPECTED.back.icon);
  });

  it('leaves no empty leading row when the early-return keyboard is built', async () => {
    // The hubs reach the back button through `appendBackToMenuRow`, which
    // starts with `.row()`. On a fresh keyboard that would dangle an empty
    // first row, so these branches must build the button directly.
    const bot = buildFakeBot();
    const deps = buildOperatorDeps({
      config: operatorConfig({
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      }),
    });
    register(registerInvitePage, bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(asCtx(ctx));
    const opts = ctx.editMessageText.mock.calls[0]?.[1] as {
      reply_markup?: { inline_keyboard?: Btn[][] };
    };
    expect(opts.reply_markup?.inline_keyboard).toHaveLength(1);
  });
});

// ── /start: quest deep link vs. the channel gate ────────────────────────────

interface StartCtxShape {
  from: { id: number; first_name: string };
  match: string;
  api: { getChatMember: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
  replyWithPhoto: ReturnType<typeof vi.fn>;
}

function buildStartCtx(match: string, getChatMember = vi.fn()): StartCtxShape {
  return {
    from: { id: 1, first_name: 'Anya' },
    match,
    api: { getChatMember },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
  };
}

/** 21 chars — satisfies the CUID grammar the deep-link validator enforces. */
const QUEST_ID = 'cabcdefghijklmnopqrst';

describe('channel.join_button / channel.check_button — two screens, one pair of labels', () => {
  beforeEach(() => {
    setPolicyCache(null);
  });

  it('resolves the operator pack tokens on the QUEST deep-link screen', async () => {
    const bot = buildFakeBot();
    const deps = buildOperatorDeps({
      adminClient: {
        quests: {
          channelTarget: vi.fn().mockResolvedValue({ joinUrl: 'https://t.me/rezeis_channel' }),
        },
      },
    });
    register(registerStartPage, bot, deps);
    const ctx = buildStartCtx(`quest_channel_${QUEST_ID}`);
    await bot.commandHandlers.get('start')?.(asCtx(ctx));

    const buttons = markup(ctx.reply.mock.calls[0]?.[1]);
    const join = pick(buttons, EXPECTED.join.text);
    const check = pick(buttons, EXPECTED.check.text);
    expect(join.url).toBe('https://t.me/rezeis_channel');
    expect(join.icon_custom_emoji_id).toBe(EXPECTED.join.icon);
    expect(check.callback_data).toBe(`quest_channel:${QUEST_ID}`);
    expect(check.icon_custom_emoji_id).toBe(EXPECTED.check.icon);
  });

  it('renders the same captions on the quest screen and the channel GATE screen', async () => {
    const gateBot = buildFakeBot();
    const gateDeps = buildOperatorDeps({
      adminClient: {
        user: { bootstrap: vi.fn().mockResolvedValue(null), exists: vi.fn().mockResolvedValue({ exists: true }) },
        system: {
          getPlatformPolicy: vi.fn().mockResolvedValue({
            channelRequired: true,
            channelId: '@rezeis_channel',
            channelLink: 'https://t.me/rezeis_channel',
            channelRecheck: true,
          }),
        },
        subscription: {
          getActive: vi.fn().mockResolvedValue(null),
          getAll: vi.fn().mockResolvedValue({ subscriptions: [] }),
        },
      },
    });
    register(registerStartPage, gateBot, gateDeps);
    const gateCtx = buildStartCtx('', vi.fn().mockResolvedValue({ status: 'left' }));
    await gateBot.commandHandlers.get('start')?.(asCtx(gateCtx));
    const gateButtons = markup(gateCtx.reply.mock.calls[0]?.[1]);

    // The gate branch has always rendered correctly — it is the reference.
    expect(captions(gateButtons)).toContain(EXPECTED.join.text);
    expect(captions(gateButtons)).toContain(EXPECTED.check.text);

    const questBot = buildFakeBot();
    const questDeps = buildOperatorDeps({
      adminClient: {
        quests: {
          channelTarget: vi.fn().mockResolvedValue({ joinUrl: 'https://t.me/rezeis_channel' }),
        },
      },
    });
    register(registerStartPage, questBot, questDeps);
    const questCtx = buildStartCtx(`quest_channel_${QUEST_ID}`);
    await questBot.commandHandlers.get('start')?.(asCtx(questCtx));

    expect(captions(markup(questCtx.reply.mock.calls[0]?.[1]))).toEqual(captions(gateButtons));
  });
});

describe('payment_return.open_app', () => {
  beforeEach(() => {
    setPolicyCache(null);
  });

  it('resolves the operator pack token on the Mini App button', async () => {
    const bot = buildFakeBot();
    const deps = buildOperatorDeps({ miniAppUrl: 'https://app.example.com' });
    register(registerStartPage, bot, deps);
    const ctx = buildStartCtx('payment_return');
    await bot.commandHandlers.get('start')?.(asCtx(ctx));

    const open = pick(markup(ctx.reply.mock.calls[0]?.[1]), EXPECTED.openApp.text);
    expect(open.web_app?.url).toBe('https://app.example.com');
    expect(open.icon_custom_emoji_id).toBe(EXPECTED.openApp.icon);
  });

  it('resolves it on the public-web fallback button too', async () => {
    const bot = buildFakeBot();
    const deps = buildOperatorDeps({ publicWebUrl: 'https://cab.example.com' });
    register(registerStartPage, bot, deps);
    const ctx = buildStartCtx('payment_return');
    await bot.commandHandlers.get('start')?.(asCtx(ctx));

    const open = pick(markup(ctx.reply.mock.calls[0]?.[1]), EXPECTED.openApp.text);
    expect(open.url).toBe('https://cab.example.com/payment-return');
    expect(open.icon_custom_emoji_id).toBe(EXPECTED.openApp.icon);
  });
});

describe('lang.ru / lang.en — the locale picker', () => {
  it('resolves the operator pack tokens on both locale buttons', async () => {
    const bot = buildFakeBot();
    const deps = buildOperatorDeps();
    register(registerLangPage, bot, deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('lang')?.(asCtx(ctx));

    const buttons = markup(ctx.reply.mock.calls[0]?.[1]);
    expect(pick(buttons, EXPECTED.langRu.text).icon_custom_emoji_id).toBe(EXPECTED.langRu.icon);
    expect(pick(buttons, EXPECTED.langEn.text).icon_custom_emoji_id).toBe(EXPECTED.langEn.icon);
    expect(pick(buttons, EXPECTED.langRu.text).callback_data).toBe('lang:ru');
    expect(pick(buttons, EXPECTED.langEn.text).callback_data).toBe('lang:en');
  });
});

function silentLogger(): LoggerPort {
  const noop = (): void => undefined;
  const logger: LoggerPort = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => logger,
  };
  return logger;
}

describe('help.contact_button on the error screen', () => {
  it('resolves the operator pack token on the support button the error handler builds', async () => {
    const reply = vi.fn(async (_text?: unknown, _options?: unknown) => undefined);
    const errorReporter: ErrorReporter = { report: vi.fn() };
    const handler = createBotErrorHandler({
      logger: silentLogger(),
      errorReporter,
      translator: operatorTranslator(),
      userLocale: {
        getSync: () => 'ru',
        setSync: () => undefined,
        hasSync: () => true,
      },
      getConfig: async () => operatorConfig(),
      envSupportUsername: 'rezeis_support',
    });
    const ctx = { from: { id: 42 }, chat: { id: 42 }, reply };
    await handler(new BotError(new UserNotFoundError('u-1'), asCtx(ctx)));

    const buttons = markup(reply.mock.calls[0]?.[1]);
    const contact = pick(buttons, EXPECTED.contact.text);
    expect(contact.icon_custom_emoji_id).toBe(EXPECTED.contact.icon);
  });
});

// ── Startup cards (operator / developer DMs) ────────────────────────────────

function captureCard(): {
  bot: Bot<BotContext>;
  sendMessage: ReturnType<typeof vi.fn>;
  buttons: () => Btn[];
} {
  const sendMessage = vi.fn(
    async (_chatId?: number, _text?: string, _other?: unknown) => undefined,
  );
  return {
    // Same test seam the sibling `startup-credits` spec uses: the cards only
    // reach `bot.api.sendMessage`, and a real grammy Bot would need a live
    // `getMe` before it would dispatch anything.
    bot: { api: { sendMessage } } as unknown as Bot<BotContext>,
    sendMessage,
    buttons: () => markup(sendMessage.mock.calls[0]?.[2]),
  };
}

describe('bot_event.* — the startup cards', () => {
  it('resolves the operator pack token on the bot-started Close button', async () => {
    const card = captureCard();
    await notifyOperatorBotStarted({
      bot: card.bot,
      devId: 42,
      adminClient: null,
      translator: operatorTranslator(),
      logger: undefined,
      getConfig: async () => operatorConfig(),
    });
    const close = pick(card.buttons(), EXPECTED.close.text);
    expect(close.callback_data).toBe('close');
    expect(close.icon_custom_emoji_id).toBe(EXPECTED.close.icon);
  });

  it('resolves the operator pack tokens on every credits-card button', async () => {
    const card = captureCard();
    await notifyDeveloperCredits({
      bot: card.bot,
      devId: 42,
      translator: operatorTranslator(),
      logger: undefined,
      getConfig: async () => operatorConfig(),
    });
    const buttons = card.buttons();
    expect(captions(buttons)).toEqual([
      'GitHub',
      'Telegram',
      'Поддержать разработчика',
      EXPECTED.close.text,
    ]);
    // The link buttons must survive the safety gate with their URLs intact —
    // resolving the caption must not disturb where the button goes.
    expect(pick(buttons, 'GitHub').url).toBe('https://github.com/dizzzable/reiwa');
    expect(pick(buttons, 'GitHub').icon_custom_emoji_id).toBe(PACK.sparkle.id);
  });

  it('still sends the card when no config source is wired (best-effort startup)', async () => {
    const card = captureCard();
    await notifyOperatorBotStarted({
      bot: card.bot,
      devId: 42,
      adminClient: null,
      translator: operatorTranslator(),
      logger: undefined,
    });
    expect(card.sendMessage).toHaveBeenCalledTimes(1);
  });
});
