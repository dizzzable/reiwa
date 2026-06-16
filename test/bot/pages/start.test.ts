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
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { registerStartPage } from '../../../src/bot/pages/start.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

interface FakeStartCtx {
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  match?: string;
  api: { getChatMember: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
  replyWithPhoto: ReturnType<typeof vi.fn>;
}

function buildStartCtx(over: Partial<FakeStartCtx> = {}): FakeStartCtx {
  return {
    from: over.from ?? { id: 1, first_name: 'Anya' },
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
    // adminClient stub).
    setPolicyCache(null);
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
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, channelUsername: '@rezeis_news' },
      },
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
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, channelUsername: '@rezeis_news' },
      },
    });
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    const ctx = buildStartCtx({
      api: { getChatMember: vi.fn().mockRejectedValue(new Error('502')) },
    });
    await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
    // Welcome reply still happens.
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.reply.mock.calls.at(-1)?.[0]).not.toBe('ru:channel.required');
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
      config: {
        ...DEFAULT_BOT_CONFIG,
        visual: { ...DEFAULT_BOT_CONFIG.visual, channelUsername: '@rezeis_news' },
      },
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
