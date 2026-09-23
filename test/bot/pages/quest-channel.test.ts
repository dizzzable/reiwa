/**
 * Channel-quest bot callback — `quest_channel:<questId>`.
 *
 * FAIL-CLOSED, unlike the fail-open channel gate («Канал обязателен») that stands
 * in front of every bot update (`middleware/channel-gate.ts`, this callback
 * included — `channel-gate-telegram.test.ts` pins that). A quest reward may
 * only be granted after a fresh positive membership proof; any Telegram error,
 * missing bot rights, or non-member status must yield a retry/not-subscribed
 * outcome and never a completion. These specs drive the handler alone, past
 * the gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerQuestChannelPage, replyWithQuestChannelPrompt } from '../../../src/bot/pages/quest-channel.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

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

// Every alert this button answers with is a translator key «Тексты бота» can
// override, with the panel's emoji picker in the field. An alert carries no
// entities: the tokens have to become glyphs here, or the user reads `:fire:`.
describe('quest_channel alerts carry the operator text, emoji tokens resolved', () => {
  const notLinked = (): Error => Object.assign(new Error('not linked'), { status: 404 });
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly key: string;
    readonly quests: () => Record<string, unknown>;
    readonly getChatMember: () => ReturnType<typeof vi.fn>;
    readonly match?: string;
  }> = [
    {
      name: 'an id the callback cannot read',
      key: 'quests.channel.retry',
      quests: () => buildAdmin().admin.quests,
      getChatMember: () => vi.fn(),
      match: '',
    },
    {
      name: 'no account behind this Telegram (target)',
      key: 'quests.channel.link_first',
      quests: () => buildAdmin({ channelTarget: vi.fn().mockRejectedValue(notLinked()) }).admin.quests,
      getChatMember: () => vi.fn(),
    },
    {
      name: 'the target cannot be read',
      key: 'quests.channel.retry',
      quests: () => buildAdmin({ channelTarget: vi.fn().mockRejectedValue(new Error('502')) }).admin.quests,
      getChatMember: () => vi.fn(),
    },
    {
      name: 'Telegram cannot say',
      key: 'quests.channel.retry',
      quests: () => buildAdmin().admin.quests,
      getChatMember: () => vi.fn().mockRejectedValue(new Error('403 bot is not a member')),
    },
    {
      name: 'not in the channel',
      key: 'quests.channel.not_subscribed',
      quests: () => buildAdmin().admin.quests,
      getChatMember: () => vi.fn().mockResolvedValue({ status: 'left' }),
    },
    {
      name: 'no account behind this Telegram (verify)',
      key: 'quests.channel.link_first',
      quests: () => buildAdmin({ verifyChannel: vi.fn().mockRejectedValue(notLinked()) }).admin.quests,
      getChatMember: () => vi.fn().mockResolvedValue({ status: 'member' }),
    },
    {
      name: 'the completion cannot be recorded',
      key: 'quests.channel.retry',
      quests: () => buildAdmin({ verifyChannel: vi.fn().mockRejectedValue(new Error('502')) }).admin.quests,
      getChatMember: () => vi.fn().mockResolvedValue({ status: 'member' }),
    },
    {
      name: 'verified',
      key: 'quests.channel.verified',
      quests: () => buildAdmin().admin.quests,
      getChatMember: () => vi.fn().mockResolvedValue({ status: 'member' }),
    },
  ];

  it.each(scenarios)('$name: $key', async ({ key, quests, getChatMember, match }) => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: { quests: quests() },
      config: operatorEmojiConfig(),
    });
    registerQuestChannelPage(bot as unknown as Parameters<typeof registerQuestChannelPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, [key]),
    });
    const ctx = buildCtx(getChatMember());
    if (match !== undefined) ctx.match = ['quest_channel:', match] as unknown as RegExpMatchArray;

    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    expect(ctx.answerCallbackQuery.mock.calls).toEqual([[{ text: OPERATOR_TEXT_GLYPHS, show_alert: true }]]);
  });

  it('the join + verify screen: its prompt message', async () => {
    const { deps } = buildDeps({ config: operatorEmojiConfig() });
    const ctx = buildCtx(vi.fn());
    await replyWithQuestChannelPrompt(
      ctx as unknown as BotContext,
      { ...deps, translator: withOperatorText(deps.translator, ['quests.channel.prompt']) },
      'cmphfcr6i007v01jg0lcu653h',
      { joinUrl: 'https://t.me/rezeis' },
    );
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });
});

// Every alert of the verify button reads the config for its emoji tokens — a
// read the button did not make before its operator copy was rendered, and it
// comes before the spinner stops. Updates are handled one at a time, and a
// config read past the cache's TTL waits for the panel: the transport's ten
// seconds when it hangs.
describe('quest_channel while the config read hangs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers with its alert within a quarter second, the words as written', async () => {
    vi.useFakeTimers();
    const { admin } = buildAdmin();
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: admin as unknown as Record<string, unknown> });
    registerQuestChannelPage(bot as unknown as Parameters<typeof registerQuestChannelPage>[0], {
      ...deps,
      getConfig: () => new Promise<never>(() => undefined),
    });
    const ctx = buildCtx(vi.fn().mockResolvedValue({ status: 'left' }));

    void bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);

    expect(ctx.answerCallbackQuery.mock.calls).toEqual([[{ text: 'ru:quests.channel.not_subscribed', show_alert: true }]]);
  });

  // The config the bot already holds — stale, but the operator's — renders the
  // alert: a read the panel is slow to answer must not strip its emoji.
  it('renders the alert from the config the bot holds', async () => {
    vi.useFakeTimers();
    const { admin } = buildAdmin();
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: admin as unknown as Record<string, unknown> });
    registerQuestChannelPage(bot as unknown as Parameters<typeof registerQuestChannelPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['quests.channel.not_subscribed']),
      getConfig: () => new Promise<never>(() => undefined),
      peekConfig: () => operatorEmojiConfig(),
    });
    const ctx = buildCtx(vi.fn().mockResolvedValue({ status: 'left' }));

    void bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);

    expect(ctx.answerCallbackQuery.mock.calls).toEqual([[{ text: OPERATOR_TEXT_GLYPHS, show_alert: true }]]);
  });

  // Checking the quest (its target, the membership, the verification) takes
  // time before the alert is due. The config is asked for AT the alert: one the
  // panel gives while the quest is being checked is the one it is rendered with.
  it('asks for the config at the alert, not before checking the quest', async () => {
    vi.useFakeTimers();
    const later = <T,>(ms: number, value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(value), ms);
      });
    const quests = {
      channelTarget: vi.fn(() =>
        later(100, { questId: 'cmphfcr6i007v01jg0lcu653h', chatId: '-1001234567890', joinUrl: 'https://t.me/rezeis' }),
      ),
      verifyChannel: vi.fn(() => later(100, { state: 'COMPLETED' })),
    };
    // The panel answers the config read 400 ms after the press, whoever asks.
    const configRead = later(400, operatorEmojiConfig());
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: { quests } });
    registerQuestChannelPage(bot as unknown as Parameters<typeof registerQuestChannelPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['quests.channel.verified']),
      getConfig: () => configRead,
    });
    const ctx = buildCtx(vi.fn(() => later(100, { status: 'member' })));

    void bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(700);

    expect(ctx.answerCallbackQuery.mock.calls).toEqual([[{ text: OPERATOR_TEXT_GLYPHS, show_alert: true }]]);
  });
});
