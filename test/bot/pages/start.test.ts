/**
 * /start page specs.
 *
 * The /start handler is the heaviest single page (bootstrap + channel
 * gate + welcome render). These specs pin the documented flow:
 *   - bootstrap is fire-and-tolerate (failure does not block the welcome)
 *   - admin-supplied locale is adopted into the user-locale cache
 *   - channel gate short-circuits with the join-channel reply when the
 *     user is `left`/`kicked`
 *   - getChatMember failure falls through (lets user in)
 *   - welcome reply renders the welcome message + main keyboard
 *   - banner reply is best-effort (replyWithPhoto errors don't block welcome)
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

import { resetChannelGateMemory } from '../../../src/bot/lib/channel-gate.js';
import { resetChannelJoinPromptMemory } from '../../../src/bot/pages/channel-join-prompt.js';
import { registerStartPage } from '../../../src/bot/pages/start.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import {
  FIRE_EMOJI_ID,
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  buildFakeCtx,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

interface FakeStartCtx {
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  /** `/start` in the user's own chat unless a spec says otherwise — the only chat the gate stands in. */
  chat?: { id: number; type: string };
  match?: string;
  api: { getChatMember: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
  replyWithPhoto: ReturnType<typeof vi.fn>;
}

function buildStartCtx(over: Partial<FakeStartCtx> = {}): FakeStartCtx {
  const from = over.from ?? { id: 1, first_name: 'Anya' };
  return {
    from,
    chat: over.chat ?? { id: from.id, type: 'private' },
    match: over.match,
    api: over.api ?? { getChatMember: vi.fn() },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
  };
}

function buildAdmin(opts: {
  bootstrap?: { language?: string } | null | (() => never);
  policy?: unknown;
  subscription?: unknown;
  exists?: boolean | (() => never);
}): PageDeps['adminClient'] {
  const bootstrap = vi.fn(async () => {
    if (typeof opts.bootstrap === 'function') opts.bootstrap();
    return opts.bootstrap ?? null;
  });
  const exists = vi.fn(async () => {
    if (typeof opts.exists === 'function') opts.exists();
    return { exists: opts.exists ?? true };
  });
  return ({
    user: { bootstrap, exists },
    system: { getPlatformPolicy: vi.fn().mockResolvedValue(opts.policy ?? null) },
    subscription: {
      getActive: vi.fn().mockResolvedValue(opts.subscription ?? null),
      getAll: vi.fn().mockResolvedValue({
        subscriptions: opts.subscription ? [opts.subscription] : [],
      }),
    },
  } as unknown) as PageDeps['adminClient'];
}

describe('registerStartPage', () => {
  beforeEach(() => {
    // PolicyCache is a singleton — reset between tests so each one
    // sees a fresh empty cache (forcing a refetch from the per-test
    // adminClient stub). The gate's memory of a user and of the prompts it
    // sent are process singletons too: every spec here is user 1.
    setPolicyCache(null);
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
  });

  it('registers the /start command', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    expect(bot.commandHandlers.has('start')).toBe(true);
  });

  it('falls back to a neutral line (not the welcome default) when the greeting is suppressed', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, welcomeMessage: '' },
      },
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toBe('ru:menu.choose_action');
  });

  it('renders the welcome message + main keyboard when no admin client', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    // One reply (welcome). Banner closure is not entered because no bannerUrl.
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.replyWithPhoto).not.toHaveBeenCalled();
  });

  it('renders the isRoot screen copy as the welcome when a flow is published', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        screens: [
          {
            id: 's1',
            shortId: 'root',
            name: 'welcome',
            textRu: 'Кастомный старт {{firstName}}',
            textEn: 'Custom start {{firstName}}',
            parseMode: 'plain',
            mediaType: null,
            mediaFileId: null,
            mediaUrl: null,
            isRoot: true,
            buttons: [],
          },
        ],
        screensVersion: 'v1',
      },
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toContain('Кастомный старт');
  });

  it('prepends the isRoot screen custom buttons above the main keyboard', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        screens: [
          {
            id: 's1',
            shortId: 'root',
            name: 'welcome',
            textRu: 'Старт',
            textEn: '',
            parseMode: 'plain',
            mediaType: null,
            mediaFileId: null,
            mediaUrl: null,
            isRoot: true,
            buttons: [
              {
                id: 'b1',
                labelRu: 'Канал',
                labelEn: 'Channel',
                row: 0,
                col: 0,
                action: 'url',
                targetShortId: null,
                url: 'https://example.com',
                webAppUrl: null,
                callbackAction: null,
                style: 'default',
                iconCustomEmojiId: null,
              },
            ],
          },
        ],
        screensVersion: 'v1',
      },
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    const opts = ctx.reply.mock.calls[0][1] as {
      reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> };
    };
    expect(opts.reply_markup.inline_keyboard[0][0].url).toBe('https://example.com');
  });

  it('adopts the admin-supplied locale into the user locale cache', async () => {
    const adminClient = buildAdmin({ bootstrap: { language: 'en' } });
    const bot = buildFakeBot();
    const { deps, userLocale } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(userLocale.getSync(1)).toBe('en');
  });

  it('renders welcome when bootstrap throws (best-effort)', async () => {
    const adminClient = buildAdmin({
      bootstrap: () => {
        throw new Error('bootstrap down');
      },
    });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    await expect(
      bot.commandHandlers.get('start')!(ctx as unknown as BotContext),
    ).resolves.toBeUndefined();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('short-circuits with channel.required when user is not subscribed', async () => {
    const adminClient = buildAdmin({
      policy: {
        channelRequired: true,
        channelLink: '@rezeis_news',
        channelId: '@rezeis_news',
      },
    });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      config: DEFAULT_BOT_CONFIG,
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx({
      api: { getChatMember: vi.fn().mockResolvedValue({ status: 'left' }) },
    });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toBe('ru:channel.required');
  });

  it('falls through (renders welcome) when getChatMember fails', async () => {
    const adminClient = buildAdmin({
      policy: { channelRequired: true, channelLink: '@rezeis_news' },
    });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      config: DEFAULT_BOT_CONFIG,
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx({
      api: { getChatMember: vi.fn().mockRejectedValue(new Error('502')) },
    });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    // The gate really was asked — without this the spec passes with the gate removed.
    expect(ctx.api.getChatMember).toHaveBeenCalledWith('@rezeis_news', 1);
    // Welcome reply still happens.
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.reply.mock.calls.at(-1)?.[0]).not.toBe('ru:channel.required');
  });

  it('typed in a group, renders nothing and bootstraps nobody', async () => {
    const adminClient = buildAdmin({
      bootstrap: { language: 'en' },
      policy: { channelRequired: true, channelLink: '@rezeis_news' },
    });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      config: DEFAULT_BOT_CONFIG,
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx({
      chat: { id: -1009876543210, type: 'supergroup' },
      api: { getChatMember: vi.fn().mockResolvedValue({ status: 'member' }) },
    });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyWithPhoto).not.toHaveBeenCalled();
    expect(ctx.api.getChatMember).not.toHaveBeenCalled();
    expect(
      (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
    ).not.toHaveBeenCalled();
  });

  it('builds a t.me URL from a @-prefixed channelLink', async () => {
    const adminClient = buildAdmin({
      policy: {
        channelRequired: true,
        channelLink: '@rezeis_news',
        channelId: '@rezeis_news',
      },
    });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      config: DEFAULT_BOT_CONFIG,
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx({
      api: { getChatMember: vi.fn().mockResolvedValue({ status: 'left' }) },
    });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    const opts = ctx.reply.mock.calls[0][1] as {
      reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> };
    };
    expect(opts.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/rezeis_news');
  });

  it('attempts banner replyWithPhoto when bannerUrl is set, swallows failures', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: {
          ...DEFAULT_BOT_CONFIG.visual,
          bannerUrl: 'https://cdn.example/banner.png',
        },
      },
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx();
    ctx.replyWithPhoto = vi.fn().mockRejectedValue(new Error('image broken'));
    await expect(
      bot.commandHandlers.get('start')!(ctx as unknown as BotContext),
    ).resolves.toBeUndefined();
    // The banner is sent as a photo carrying the welcome caption +
    // main keyboard (STEALTHNET single-screen chrome), so the call has
    // a second options argument. Assert the photo source (1st arg) and
    // that the caption/keyboard ride along on the options bag.
    expect(ctx.replyWithPhoto).toHaveBeenCalledWith(
      'https://cdn.example/banner.png',
      expect.objectContaining({
        caption: expect.any(String),
        reply_markup: expect.anything(),
      }),
    );
    // Welcome reply still happens (photo failed → plain-text fallback).
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('routes bootstrap + banner failures through deps.logger when supplied', async () => {
    const adminClient = buildAdmin({
      bootstrap: () => {
        throw new Error('bootstrap-down');
      },
    });
    const warn = vi.fn();
    const logger = {
      fatal: vi.fn(),
      error: vi.fn(),
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    };
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: {
          ...DEFAULT_BOT_CONFIG.visual,
          bannerUrl: 'https://cdn.example/banner.png',
        },
      },
    });
    const depsWithLogger: PageDeps = {
      ...deps,
      logger: logger as unknown as PageDeps['logger'],
    };
    registerStartPage(
      bot as unknown as Parameters<typeof registerStartPage>[0],
      depsWithLogger,
    );
    const ctx = buildStartCtx();
    ctx.replyWithPhoto = vi.fn().mockRejectedValue(new Error('image broken'));
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    // Two warnings: bootstrap + banner.
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    const messages = warn.mock.calls.map((c) => c[1] as string);
    expect(messages).toContain('bot/start bootstrap error');
    expect(messages).toContain('bot/start banner send failed');
  });

  // ── Access-mode matrix (Phase 0.9 gate, runs BEFORE bootstrap) ──────────────
  describe('access-mode gate', () => {
    it('RESTRICTED → replies the restricted notice and skips bootstrap', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'RESTRICTED' } });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx();
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toBe('ru:access_mode.restricted');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).not.toHaveBeenCalled();
    });

    it('REG_BLOCKED + brand-new user → reg-blocked notice, no bootstrap', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'REG_BLOCKED' }, exists: false });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx();
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      expect(ctx.reply.mock.calls[0][0]).toBe('ru:access_mode.reg_blocked_new');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).not.toHaveBeenCalled();
    });

    it('REG_BLOCKED + existing user → falls through to welcome + bootstrap', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'REG_BLOCKED' }, exists: true });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx();
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      expect(ctx.reply.mock.calls.at(-1)?.[0]).not.toBe('ru:access_mode.reg_blocked_new');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).toHaveBeenCalled();
    });

    it('INVITED + new user + no referral payload → invite-required notice', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'INVITED' }, exists: false });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx();
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      expect(ctx.reply.mock.calls[0][0]).toBe('ru:access_mode.invited_no_code');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).not.toHaveBeenCalled();
    });

    it('INVITED + new user + referral payload → falls through to bootstrap', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'INVITED' }, exists: false });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx({ match: 'REFCODE123' });
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      expect(ctx.reply.mock.calls.at(-1)?.[0]).not.toBe('ru:access_mode.invited_no_code');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).toHaveBeenCalled();
    });

    it('INVITED + existing user → no gate, welcome + bootstrap', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'INVITED' }, exists: true });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx();
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      expect(ctx.reply.mock.calls.at(-1)?.[0]).not.toBe('ru:access_mode.invited_no_code');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).toHaveBeenCalled();
    });

    it('PURCHASE_BLOCKED → no /start gate (purchases gated elsewhere)', async () => {
      const adminClient = buildAdmin({ policy: { accessMode: 'PURCHASE_BLOCKED' }, exists: false });
      const bot = buildFakeBot();
      const { deps } = buildDeps({
        adminOverrides: adminClient as unknown as Record<string, unknown>,
      });
      registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
      const ctx = buildStartCtx();
      await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
      const keys = ctx.reply.mock.calls.map((c) => c[0] as string);
      expect(keys).not.toContain('ru:access_mode.restricted');
      expect(keys).not.toContain('ru:access_mode.reg_blocked_new');
      expect(keys).not.toContain('ru:access_mode.invited_no_code');
      expect(
        (adminClient as unknown as { user: { bootstrap: ReturnType<typeof vi.fn> } }).user.bootstrap,
      ).toHaveBeenCalled();
    });
  });
});

// Every text `/start` and «В меню» answer with is a translator key «Тексты
// бота» can override, with the panel's emoji picker in the field. A message
// carries the pack emoji's entity, an alert only its glyph; sent raw, the user
// read `:fire:` and `{{GIFT}}`.
describe('/start and «В меню» answer with the operator text, emoji tokens resolved', () => {
  beforeEach(() => {
    setPolicyCache(null);
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
  });

  function startWith(
    keys: readonly string[],
    options: { adminClient?: unknown; config?: BotConfig; miniAppUrl?: string } = {},
  ): ReturnType<typeof buildFakeBot> {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: options.config ?? operatorEmojiConfig(),
      ...(options.adminClient !== undefined ? { adminOverrides: options.adminClient as Record<string, unknown> } : {}),
      ...(options.miniAppUrl !== undefined ? { miniAppUrl: options.miniAppUrl, publicWebUrl: options.miniAppUrl } : {}),
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, keys),
    });
    return bot;
  }

  function firstMessage(ctx: FakeStartCtx): { text: string; entities: unknown } {
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown } | undefined];
    return { text, entities: opts?.entities };
  }

  it('the neutral line that stands in for a hidden greeting', async () => {
    const bot = startWith(['menu.choose_action'], {
      config: operatorEmojiConfig({
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, welcomeMessage: '' },
      }),
    });
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('an access-mode refusal', async () => {
    const bot = startWith(['access_mode.restricted'], {
      adminClient: buildAdmin({ policy: { accessMode: 'RESTRICTED' } }),
    });
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('a Telegram account linked from the cabinet', async () => {
    const admin = {
      ...(buildAdmin({}) as object),
      linking: { telegram: { consume: vi.fn().mockResolvedValue({ success: true }) } },
    };
    const bot = startWith(['link.success'], { adminClient: admin });
    const ctx = buildStartCtx({ match: 'link_123456' });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('a link code that could not be consumed', async () => {
    const admin = {
      ...(buildAdmin({}) as object),
      linking: { telegram: { consume: vi.fn().mockRejectedValue(new Error('502')) } },
    };
    const bot = startWith(['link.error'], { adminClient: admin });
    const ctx = buildStartCtx({ match: 'link_123456' });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('the acknowledgement of a payment the buyer returned from', async () => {
    const bot = startWith(['payment_return.title']);
    const ctx = buildStartCtx({ match: 'payment_return' });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('a quest link whose id is malformed', async () => {
    const bot = startWith(['quests.channel.retry'], { adminClient: buildAdmin({}) });
    const ctx = buildStartCtx({ match: 'quest_channel_not-a-quest' });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('a quest link whose quest cannot be read', async () => {
    const admin = {
      ...(buildAdmin({}) as object),
      quests: { channelTarget: vi.fn().mockRejectedValue(new Error('502')) },
    };
    const bot = startWith(['quests.channel.retry'], { adminClient: admin });
    const ctx = buildStartCtx({ match: 'quest_channel_cabcdefghijklmnopqrst' });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    expect(firstMessage(ctx)).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('the trial button: a leading pack emoji becomes its icon, the rest glyphs', async () => {
    const admin = {
      ...(buildAdmin({}) as object),
      webAuth: { issueBotSigninToken: vi.fn().mockResolvedValue({ token: 'signin-token' }) },
      trial: { getEligibility: vi.fn().mockResolvedValue({ eligible: true, reason: null }) },
    };
    const bot = startWith(['menu.btn_trial_free'], { adminClient: admin, miniAppUrl: 'https://reiwa.example' });
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    const opts = ctx.reply.mock.calls.at(-1)?.[1] as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; icon_custom_emoji_id?: string; style?: string }>> };
    };
    const trial = opts.reply_markup.inline_keyboard[0][0];
    expect(trial.style).toBe('success');
    expect({ text: trial.text, icon: trial.icon_custom_emoji_id }).toEqual({
      text: 'Здравствуйте! 🎁',
      icon: FIRE_EMOJI_ID,
    });
  });

  it('the trial button of an owner without Premium: the registry’s glyph, no icon', async () => {
    const admin = {
      ...(buildAdmin({}) as object),
      webAuth: { issueBotSigninToken: vi.fn().mockResolvedValue({ token: 'signin-token' }) },
      trial: { getEligibility: vi.fn().mockResolvedValue({ eligible: true, reason: null }) },
    };
    const bot = startWith([], {
      adminClient: admin,
      miniAppUrl: 'https://reiwa.example',
      config: {
        ...DEFAULT_BOT_CONFIG,
        botEmojis: { TRIAL: { unicode: '🆓', tgEmojiId: '5203996991054432397' } },
        botEmojiOwnerHasPremium: false,
      },
    });
    const ctx = buildStartCtx();
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    const opts = ctx.reply.mock.calls.at(-1)?.[1] as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; icon_custom_emoji_id?: string; style?: string }>> };
    };
    const trial = opts.reply_markup.inline_keyboard[0][0];
    expect(trial.style).toBe('success');
    expect({ text: trial.text, icon: trial.icon_custom_emoji_id }).toEqual({
      text: '🆓 ru:menu.btn_trial_free',
      icon: undefined,
    });
  });

  it('«В меню» under RESTRICTED: the refusal alert', async () => {
    const bot = startWith(['access_mode.restricted'], {
      adminClient: buildAdmin({ policy: { accessMode: 'RESTRICTED' } }),
    });
    const ctx = { ...buildFakeCtx({ from: { id: 1 } }), chat: { id: 1, type: 'private' } };
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'menu:main')!.handler;
    await handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: OPERATOR_TEXT_GLYPHS, show_alert: true });
  });
});

// The panel's notification editor takes a button's callback data as free text,
// and «Карта бота» has drawn `menu` as the way back to the menu since June. The
// bot answered `menu:main` only, so such a button spun and did nothing.
describe('`menu` — «В меню» as the notification editor writes it', () => {
  beforeEach(() => {
    setPolicyCache(null);
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
  });

  function handlerFor(bot: ReturnType<typeof buildFakeBot>, data: string) {
    return bot.callbackHandlers.find((h) =>
      typeof h.matcher === 'string' ? h.matcher === data : h.matcher.test(data),
    )?.handler;
  }

  it('is answered by the very handler `menu:main` is', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    expect(handlerFor(bot, 'menu')).toBeDefined();
    expect(handlerFor(bot, 'menu')).toBe(handlerFor(bot, 'menu:main'));
  });

  it('puts the welcome screen back in place, answering the press once', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = { ...buildFakeCtx({ from: { id: 1 } }), chat: { id: 1, type: 'private' } };
    await handlerFor(bot, 'menu')!(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('Привет');
  });
});

// The short answers here read the config for their emoji tokens only: reads
// these paths did not make before their operator copy was rendered. Updates are
// handled one at a time, and a config read past the cache's TTL waits for the
// panel — the transport's ten seconds when it hangs — holding this answer and
// every update queued behind it. The words go out as written instead.
describe('/start and «В меню» while the config read hangs', () => {
  beforeEach(() => {
    setPolicyCache(null);
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const hangs = (): Promise<BotConfig> => new Promise<BotConfig>(() => undefined);

  function startHanging(adminClient?: unknown): ReturnType<typeof buildFakeBot> {
    const bot = buildFakeBot();
    const { deps } = buildDeps(
      adminClient !== undefined ? { adminOverrides: adminClient as Record<string, unknown> } : {},
    );
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], { ...deps, getConfig: hangs });
    return bot;
  }

  it('an access-mode refusal: within a second, its words as written', async () => {
    vi.useFakeTimers();
    const bot = startHanging(buildAdmin({ policy: { accessMode: 'RESTRICTED' } }));
    const ctx = buildStartCtx();
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('ru:access_mode.restricted', {});
  });

  it('a quest link whose id is malformed: within a second', async () => {
    vi.useFakeTimers();
    const bot = startHanging(buildAdmin({}));
    const ctx = buildStartCtx({ match: 'quest_channel_not-a-quest' });
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('ru:quests.channel.retry', {});
  });

  it('the acknowledgement of a payment the buyer returned from: within a second', async () => {
    vi.useFakeTimers();
    const bot = startHanging();
    const ctx = buildStartCtx({ match: 'payment_return' });
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0]?.[0]).toBe('ru:payment_return.title');
  });

  it('a password-reset request the bot cannot serve: within a second', async () => {
    vi.useFakeTimers();
    const bot = startHanging();
    const ctx = buildStartCtx({ match: 'pwreset' });
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('ru:password_reset.unavailable', {});
  });

  it('«В меню» under RESTRICTED: the refusal alert within a quarter second', async () => {
    vi.useFakeTimers();
    const bot = startHanging(buildAdmin({ policy: { accessMode: 'RESTRICTED' } }));
    const ctx = { ...buildFakeCtx({ from: { id: 1 } }), chat: { id: 1, type: 'private' } };
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'menu:main')!.handler;
    void handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({
      text: 'ru:access_mode.restricted',
      show_alert: true,
    });
  });
});

// While the panel is slow, the config the bot already holds — stale, but the
// operator's — renders these answers: a read that does not come in time must
// not strip their emoji. And the config is asked for AT the answer, so one the
// panel gives while `/start` does its other work is the one used.
describe('/start and «В меню» with the config the bot holds', () => {
  beforeEach(() => {
    setPolicyCache(null);
    resetChannelGateMemory();
    resetChannelJoinPromptMemory();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const hangs = (): Promise<BotConfig> => new Promise<BotConfig>(() => undefined);
  const later = <T,>(ms: number, value: T): Promise<T> =>
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(value), ms);
    });

  function startWithHeld(
    keys: readonly string[],
    options: { adminClient?: unknown; miniAppUrl?: string; getConfig?: () => Promise<BotConfig>; held?: BotConfig | null } = {},
  ): ReturnType<typeof buildFakeBot> {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: operatorEmojiConfig(),
      ...(options.adminClient !== undefined ? { adminOverrides: options.adminClient as Record<string, unknown> } : {}),
      ...(options.miniAppUrl !== undefined ? { miniAppUrl: options.miniAppUrl, publicWebUrl: options.miniAppUrl } : {}),
    });
    const held = options.held === undefined ? operatorEmojiConfig() : options.held;
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, keys),
      getConfig: options.getConfig ?? hangs,
      peekConfig: () => held,
    });
    return bot;
  }

  it('an access-mode refusal', async () => {
    vi.useFakeTimers();
    const bot = startWithHeld(['access_mode.restricted'], {
      adminClient: buildAdmin({ policy: { accessMode: 'RESTRICTED' } }),
    });
    const ctx = buildStartCtx();
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith(OPERATOR_TEXT_GLYPHS, { entities: [FIRE_ENTITY] });
  });

  // `/start payment_return` read the config and waited for it in the release:
  // its «Открыть приложение» caption had the operator's emoji and icon. It has
  // them whenever the bot holds a config — a read that does not come in time
  // included.
  it.each([
    ['the read answers', async () => operatorEmojiConfig(), null],
    ['only the config the bot holds is at hand', hangs, operatorEmojiConfig()],
  ] as const)('payment_return: «Открыть приложение» with its emoji and icon when %s', async (_when, getConfig, held) => {
    vi.useFakeTimers();
    const bot = startWithHeld(['payment_return.open_app'], {
      miniAppUrl: 'https://cabinet.example',
      getConfig,
      held,
    });
    const ctx = buildStartCtx({ match: 'payment_return' });
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [, opts] = ctx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: unknown[][] } }];
    expect(opts.reply_markup.inline_keyboard.flat()).toEqual([
      { text: 'Здравствуйте! 🎁', icon_custom_emoji_id: FIRE_EMOJI_ID, web_app: { url: 'https://cabinet.example' } },
    ]);
  });

  // A boot while the panel hangs: the boot read times out and the bot runs on
  // the saved copy. The caption is rendered from that copy, through the real
  // cache, while the panel still does not answer.
  it('payment_return right after a boot on the saved copy, the panel hanging: the caption’s emoji and icon', async () => {
    vi.useFakeTimers();
    const hangingPanel = (): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('headers timeout')), 10_000);
      });
    const cache = new BotConfigCache({
      fetcher: hangingPanel,
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      persistence: { load: async () => operatorEmojiConfig(), save: async () => undefined },
    });
    const boot = cache.get();
    await vi.advanceTimersByTimeAsync(10_000);
    await boot;
    // Past the hold-off after the failed boot read: `/start` finds the cache
    // asking the panel again, and the caption falls back on the copy it holds.
    await vi.advanceTimersByTimeAsync(10_000);

    const bot = buildFakeBot();
    const { deps } = buildDeps({ miniAppUrl: 'https://cabinet.example', publicWebUrl: 'https://cabinet.example' });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['payment_return.open_app']),
      getConfig: () => cache.get(),
      peekConfig: () => cache.peek(),
    });
    const ctx = buildStartCtx({ match: 'payment_return' });
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [, opts] = ctx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: unknown[][] } }];
    expect(opts.reply_markup.inline_keyboard.flat()).toEqual([
      { text: 'Здравствуйте! 🎁', icon_custom_emoji_id: FIRE_EMOJI_ID, web_app: { url: 'https://cabinet.example' } },
    ]);
  });

  it('asks for the config at the answer, not before the link code is consumed', async () => {
    vi.useFakeTimers();
    // The link code takes 1.2 s to consume; the panel answers the config read
    // 1.5 s after `/start`, whoever asks.
    const configRead = later(1_500, operatorEmojiConfig());
    const admin = {
      ...(buildAdmin({}) as object),
      linking: { telegram: { consume: vi.fn(() => later(1_200, { success: true })) } },
    };
    const bot = startWithHeld(['link.success'], { adminClient: admin, getConfig: () => configRead, held: null });
    const ctx = buildStartCtx({ match: 'link_123456' });
    void bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ctx.reply.mock.calls[0]).toEqual([OPERATOR_TEXT_GLYPHS, { entities: [FIRE_ENTITY] }]);
  });

  it('«В меню» under RESTRICTED: the refusal alert', async () => {
    vi.useFakeTimers();
    const bot = startWithHeld(['access_mode.restricted'], {
      adminClient: buildAdmin({ policy: { accessMode: 'RESTRICTED' } }),
    });
    const ctx = { ...buildFakeCtx({ from: { id: 1 } }), chat: { id: 1, type: 'private' } };
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'menu:main')!.handler;
    void handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({ text: OPERATOR_TEXT_GLYPHS, show_alert: true });
  });
});
