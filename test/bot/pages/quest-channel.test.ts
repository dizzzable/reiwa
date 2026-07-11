/**
 * Channel-quest bot callback — `quest_channel:<questId>`.
 *
 * FAIL-CLOSED, unlike the fail-open login gate in menu.ts. A quest reward may
 * only be granted after a fresh positive membership proof; any Telegram error,
 * missing bot rights, or non-member status must yield a retry/not-subscribed
 * outcome and never a completion.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerQuestChannelPage } from '../../../src/bot/pages/quest-channel.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot } from './helpers.js';

function buildAdmin(overrides: Record<string, unknown> = {}) {
  const verifyChannel = vi.fn().mockResolvedValue({ state: 'COMPLETED' });
  const channelTarget = vi.fn().mockResolvedValue({
    questId: 'cmphfcr6i007v01jg0lcu653h',
    chatId: '-1001234567890',
    joinUrl: 'https://t.me/rezeis',
  });
  const admin = { quests: { verifyChannel, channelTarget, ...overrides } };
  return { admin, verifyChannel, channelTarget };
}

function buildCtx(getChatMember: ReturnType<typeof vi.fn>, match = 'cmphfcr6i007v01jg0lcu653h') {
  return {
    from: { id: 42 },
    match: [`quest_channel:${match}`, match] as unknown as RegExpMatchArray,
    api: { getChatMember },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function register(admin: unknown) {
  const bot = buildFakeBot();
  const { deps } = buildDeps({ adminOverrides: admin as Record<string, unknown> });
  registerQuestChannelPage(bot as unknown as Parameters<typeof registerQuestChannelPage>[0], deps);
  const handler = bot.callbackHandlers[0].handler;
  return { bot, handler };
}

describe('registerQuestChannelPage', () => {
  it('registers exactly one strict quest_channel callback', () => {
    const { admin } = buildAdmin();
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: admin as unknown as Record<string, unknown> });
    registerQuestChannelPage(bot as unknown as Parameters<typeof registerQuestChannelPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBeInstanceOf(RegExp);
    expect((bot.callbackHandlers[0].matcher as RegExp).source).toContain('quest_channel');
  });

  it('verifies membership and calls verifyChannel on a positive member status', async () => {
    const { admin, verifyChannel } = buildAdmin();
    const { handler } = register(admin);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const ctx = buildCtx(getChatMember);

    await handler(ctx as unknown as BotContext);

    expect(getChatMember).toHaveBeenCalledWith('-1001234567890', 42);
    expect(verifyChannel).toHaveBeenCalledWith({ telegramId: '42', questId: 'cmphfcr6i007v01jg0lcu653h' });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('quests.channel.verified') }),
    );
  });

  it('treats restricted with is_member=false as NOT subscribed (no verify)', async () => {
    const { admin, verifyChannel } = buildAdmin();
    const { handler } = register(admin);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'restricted', is_member: false });
    const ctx = buildCtx(getChatMember);

    await handler(ctx as unknown as BotContext);

    expect(verifyChannel).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('quests.channel.not_subscribed') }),
    );
  });

  it('accepts restricted with is_member=true', async () => {
    const { admin, verifyChannel } = buildAdmin();
    const { handler } = register(admin);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'restricted', is_member: true });
    const ctx = buildCtx(getChatMember);

    await handler(ctx as unknown as BotContext);

    expect(verifyChannel).toHaveBeenCalled();
  });

  it('FAILS CLOSED on a Telegram error — retry state, no verify', async () => {
    const { admin, verifyChannel } = buildAdmin();
    const { handler } = register(admin);
    const getChatMember = vi.fn().mockRejectedValue(new Error('403 bot is not a member'));
    const ctx = buildCtx(getChatMember);

    await handler(ctx as unknown as BotContext);

    expect(verifyChannel).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('quests.channel.retry') }),
    );
  });

  it('does not call the Bot API when the callback id is malformed', async () => {
    const { admin, channelTarget } = buildAdmin();
    const { handler } = register(admin);
    const getChatMember = vi.fn();
    const ctx = buildCtx(getChatMember, 'not a valid id!!');
    // Force a non-matching match array (grammy would not route it, but guard anyway).
    ctx.match = ['quest_channel:', ''] as unknown as RegExpMatchArray;

    await handler(ctx as unknown as BotContext);

    expect(channelTarget).not.toHaveBeenCalled();
    expect(getChatMember).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('guides the user to link Telegram when the account is not linked', async () => {
    const channelTarget = vi.fn().mockResolvedValue({
      questId: 'cmphfcr6i007v01jg0lcu653h',
      chatId: '-1001234567890',
      joinUrl: 'https://t.me/rezeis',
    });
    const verifyChannel = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not linked'), { status: 404 }));
    const admin = { quests: { channelTarget, verifyChannel } };
    const { handler } = register(admin);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const ctx = buildCtx(getChatMember);

    await handler(ctx as unknown as BotContext);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});
