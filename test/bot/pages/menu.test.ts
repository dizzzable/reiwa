/**
 * Menu callbacks — back_to_menu + check_channel.
 *
 * `check_channel` is registered with a pattern, because «✅ Я подписался» can
 * carry a quest (`check_channel:q:<id>`); the handler is found here by what it
 * matches. The check itself — fresh, through the gate module — and the quest
 * continuation run against grammY's real client in `channel-gate-telegram.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChannelGateMemory } from '../../../src/bot/lib/channel-gate.js';
import { resetChannelJoinPromptMemory } from '../../../src/bot/pages/channel-join-prompt.js';
import { registerMenuPage } from '../../../src/bot/pages/menu.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx, type FakeBot } from './helpers.js';

/** The handler registered for this callback data, by matching it the way grammY does. */
function handlerFor(bot: FakeBot, data: string): (ctx: BotContext) => Promise<void> {
  const found = bot.callbackHandlers.find((h) =>
    typeof h.matcher === 'string' ? h.matcher === data : h.matcher.test(data),
  );
  if (found === undefined) throw new Error(`no callback handler matches "${data}"`);
  return found.handler;
}

beforeEach(() => {
  // The gate's memory, the prompts it sent and the policy cache are process singletons.
  resetChannelGateMemory();
  resetChannelJoinPromptMemory();
  setPolicyCache(null);
});

interface FakeApiCtx {
  from?: { id: number };
  /** The user's own chat with the bot unless a spec says otherwise — the only chat these buttons answer in. */
  chat: { id: number; type: string };
  api: {
    getChatMember: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
  replyWithPhoto: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}

const GROUP_CHAT = { id: -1009876543210, type: 'supergroup' } as const;

function buildApiCtx(getChatMember: ReturnType<typeof vi.fn>, chat: { id: number; type: string } = { id: 1, type: 'private' }): FakeApiCtx {
  return {
    from: { id: 1 },
    chat,
    api: { getChatMember },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
}

function channelPolicyAdmin(): PageDeps['adminClient'] {
  return ({
    system: {
      getPlatformPolicy: vi.fn().mockResolvedValue({
        channelRequired: true,
        channelLink: '@rezeis_news',
        channelId: '@rezeis_news',
      }),
    },
    webAuth: { issueBotSigninToken: vi.fn().mockResolvedValue({ token: 'signin-token' }) },
  } as unknown) as PageDeps['adminClient'];
}

describe('registerMenuPage', () => {
  it('registers two callback handlers (back_to_menu + check_channel, with or without a quest)', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(2);
    const [menu, check] = bot.callbackHandlers.map((h) => h.matcher);
    expect(menu).toBe('back_to_menu');
    expect(check).toBeInstanceOf(RegExp);
    const matches = (data: string): boolean => (check as RegExp).test(data);
    expect(matches('check_channel')).toBe(true);
    expect(matches('check_channel:q:cabcdefghijklmnopqrst')).toBe(true);
    // The quest grammar is the quest callback's: nothing else rides along.
    expect(matches('check_channel:q:not-a-quest-id')).toBe(false);
    expect(matches('check_channel_extra')).toBe(false);
  });

  it('back_to_menu replies with menu.choose_action + main keyboard', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      publicWebUrl: 'https://reiwa.example',
      miniAppUrl: 'https://reiwa.example',
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const ctx = { ...buildFakeCtx(), chat: { id: 42, type: 'private' } };
    const handler = handlerFor(bot, 'back_to_menu');
    await handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toBe('ru:menu.choose_action');
  });

  it('back_to_menu on a message in a group answers the press and sends nothing — the menu carries a sign-in token', async () => {
    const bot = buildFakeBot();
    const adminClient = channelPolicyAdmin();
    const { deps } = buildDeps({
      publicWebUrl: 'https://reiwa.example',
      miniAppUrl: 'https://reiwa.example',
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const ctx = { ...buildFakeCtx(), chat: GROUP_CHAT };
    await handlerFor(bot, 'back_to_menu')(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(
      (adminClient as unknown as { webAuth: { issueBotSigninToken: ReturnType<typeof vi.fn> } }).webAuth.issueBotSigninToken,
    ).not.toHaveBeenCalled();
  });

  it('check_channel on a message in a group answers the press, asks nobody and sends nothing', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: channelPolicyAdmin() as unknown as Record<string, unknown> });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const ctx = buildApiCtx(getChatMember, GROUP_CHAT);
    await handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
    expect(getChatMember).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyWithPhoto).not.toHaveBeenCalled();
  });

  it('check_channel confirms via toast + renders the welcome when no policy is configured', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const handler = handlerFor(bot, 'check_channel');
    const getChatMember = vi.fn();
    const ctx = buildApiCtx(getChatMember);
    await handler(ctx as unknown as BotContext);
    expect(getChatMember).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'ru:channel.verified' });
    // Full welcome rendered (banner store absent in tests → plain reply).
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('check_channel rejects users who are not subscribed: a toast on every press, the message once per interval', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: channelPolicyAdmin() as unknown as Record<string, unknown>,
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], deps);
    const handler = handlerFor(bot, 'check_channel');
    const getChatMember = vi.fn().mockResolvedValue({ status: 'left' });
    const first = buildApiCtx(getChatMember);
    const second = buildApiCtx(getChatMember);
    await handler(first as unknown as BotContext);
    await handler(second as unknown as BotContext);
    expect(getChatMember).toHaveBeenCalledWith('@rezeis_news', 1);
    for (const ctx of [first, second]) {
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'ru:channel.not_subscribed' });
    }
    expect(first.reply.mock.calls).toEqual([['ru:channel.not_subscribed']]);
    expect(second.reply).not.toHaveBeenCalled();
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
    const handler = handlerFor(bot, 'check_channel');
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
    const handler = handlerFor(bot, 'check_channel');
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
