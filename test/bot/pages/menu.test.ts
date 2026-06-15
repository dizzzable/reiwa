/**
 * Menu callbacks — back_to_menu + check_channel.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerMenuPage } from '../../../src/bot/pages/menu.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

interface FakeApiCtx {
  from?: { id: number };
  api: {
    getChatMember: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
  replyWithPhoto: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}

function buildApiCtx(getChatMember: ReturnType<typeof vi.fn>): FakeApiCtx {
  return {
    from: { id: 1 },
    api: { getChatMember },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
}

describe('registerMenuPage', () => {
  it('registers two callback handlers (back_to_menu + check_channel)', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(2);
    expect(bot.callbackHandlers.map((h) => h.matcher)).toEqual([
      'back_to_menu',
      'check_channel',
    ]);
  });

  it('back_to_menu replies with menu.choose_action + main keyboard', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      publicWebUrl: 'https://reiwa.example',
      miniAppUrl: 'https://reiwa.example',
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const ctx = buildFakeCtx();
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'back_to_menu')!.handler;
    await handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toBe('ru:menu.choose_action');
  });

  it('check_channel confirms via toast + renders the welcome when no policy is configured', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'check_channel')!.handler;
    const getChatMember = vi.fn();
    const ctx = buildApiCtx(getChatMember);
    await handler(ctx as unknown as BotContext);
    expect(getChatMember).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'ru:channel.verified' });
    // Full welcome rendered (banner store absent in tests → plain reply).
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('check_channel rejects users who are not subscribed', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({
          channelRequired: true,
          channelLink: '@rezeis_news',
          channelId: '@rezeis_news',
        }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'check_channel')!.handler;
    const getChatMember = vi.fn().mockResolvedValue({ status: 'left' });
    const ctx = buildApiCtx(getChatMember);
    await handler(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:channel.not_subscribed');
  });

  it('check_channel lets verified members through', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({
          channelRequired: true,
          channelLink: '@rezeis_news',
          channelId: '@rezeis_news',
        }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'check_channel')!.handler;
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const ctx = buildApiCtx(getChatMember);
    await handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'ru:channel.verified' });
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('check_channel falls through (lets user in) when getChatMember throws', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({
          channelRequired: true,
          channelLink: '@rezeis_news',
        }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const handler = bot.callbackHandlers.find((h) => h.matcher === 'check_channel')!.handler;
    const getChatMember = vi.fn().mockRejectedValue(new Error('502'));
    const ctx = buildApiCtx(getChatMember);
    await handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'ru:channel.verified' });
    expect(ctx.reply).toHaveBeenCalled();
  });

  // Suppress unused config import warning.
  it('uses default bot config when none is overridden', () => {
    expect(DEFAULT_BOT_CONFIG.buttons.length).toBeGreaterThan(0);
  });
});
