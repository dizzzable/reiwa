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
import { describe, expect, it, vi } from 'vitest';

import { registerStartPage } from '../../../src/bot/pages/start.js';
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
  api: { getChatMember: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
  replyWithPhoto: ReturnType<typeof vi.fn>;
}

function buildStartCtx(over: Partial<FakeStartCtx> = {}): FakeStartCtx {
  return {
    from: over.from ?? { id: 1, first_name: 'Anya' },
    api: over.api ?? { getChatMember: vi.fn() },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
  };
}

function buildAdmin(opts: {
  bootstrap?: { language?: string } | null | (() => never);
  policy?: unknown;
  subscription?: unknown;
}): PageDeps['adminClient'] {
  const bootstrap = vi.fn(async () => {
    if (typeof opts.bootstrap === 'function') opts.bootstrap();
    return opts.bootstrap ?? null;
  });
  return ({
    user: { bootstrap },
    system: { getPlatformPolicy: vi.fn().mockResolvedValue(opts.policy ?? null) },
    subscription: { getActive: vi.fn().mockResolvedValue(opts.subscription ?? null) },
  } as unknown) as PageDeps['adminClient'];
}

describe('registerStartPage', () => {
  it('registers the /start command', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
    expect(bot.commandHandlers.has('start')).toBe(true);
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
    expect(ctx.replyWithPhoto).toHaveBeenCalledWith('https://cdn.example/banner.png');
    // Welcome reply still happens.
    expect(ctx.reply).toHaveBeenCalled();
  });
});
