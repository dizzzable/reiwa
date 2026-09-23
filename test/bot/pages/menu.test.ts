/**
 * Menu callbacks — back_to_menu + check_channel.
 *
 * `check_channel` is registered with a pattern, because «✅ Я подписался» can
 * carry a quest (`check_channel:q:<id>`); the handler is found here by what it
 * matches. The check itself — fresh, through the gate module — and the quest
 * continuation run against grammY's real client in `channel-gate-telegram.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChannelGateMemory } from '../../../src/bot/lib/channel-gate.js';
import { resetChannelJoinPromptMemory } from '../../../src/bot/pages/channel-join-prompt.js';
import { registerMenuPage } from '../../../src/bot/pages/menu.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  buildFakeCtx,
  operatorEmojiConfig,
  withOperatorText,
  type FakeBot,
} from './helpers.js';

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
    // `{}`: no emoji entities in this text, so none are sent.
    expect(first.reply.mock.calls).toEqual([['ru:channel.not_subscribed', {}]]);
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

// Every text these two buttons answer with is a translator key «Тексты бота»
// can override, with the panel's emoji picker in the field. A toast carries no
// entities, so its tokens become glyphs; a message carries the pack emoji's
// entity too. Sent raw, the user read `:fire:` and `{{GIFT}}`.
describe('menu callbacks answer with the operator text, emoji tokens resolved', () => {
  function registerWith(keys: readonly string[], adminClient: unknown = null): FakeBot {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: operatorEmojiConfig(),
      ...(adminClient !== null ? { adminOverrides: adminClient as Record<string, unknown> } : {}),
    });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, keys),
    });
    return bot;
  }

  it('back_to_menu: the «choose an action» message', async () => {
    const bot = registerWith(['menu.choose_action']);
    const ctx = { ...buildFakeCtx(), chat: { id: 42, type: 'private' } };
    await handlerFor(bot, 'back_to_menu')(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });

  it('check_channel under RESTRICTED: the refusal alert', async () => {
    const admin = { system: { getPlatformPolicy: vi.fn().mockResolvedValue({ accessMode: 'RESTRICTED' }) } };
    const bot = registerWith(['access_mode.restricted'], admin);
    const ctx = buildApiCtx(vi.fn());
    await handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: OPERATOR_TEXT_GLYPHS, show_alert: true });
  });

  it('check_channel by somebody still outside: the toast and the message', async () => {
    const bot = registerWith(['channel.not_subscribed'], channelPolicyAdmin());
    const ctx = buildApiCtx(vi.fn().mockResolvedValue({ status: 'left' }));
    await handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: OPERATOR_TEXT_GLYPHS });
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });

  it('check_channel passed: the «verified» toast', async () => {
    const bot = registerWith(['channel.verified']);
    const ctx = buildApiCtx(vi.fn());
    await handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: OPERATOR_TEXT_GLYPHS });
  });

  it('check_channel carrying a quest the user has no account for: «link your Telegram first»', async () => {
    const admin = {
      system: { getPlatformPolicy: vi.fn().mockResolvedValue({ accessMode: 'PUBLIC' }) },
      quests: {
        channelTarget: vi.fn().mockRejectedValue(Object.assign(new Error('not linked'), { status: 404 })),
      },
      webAuth: { issueBotSigninToken: vi.fn().mockResolvedValue({ token: 'signin-token' }) },
    };
    const bot = registerWith(['quests.channel.link_first'], admin);
    const ctx = { ...buildApiCtx(vi.fn()), match: ['check_channel:q:cabcdefghijklmnopqrst', 'cabcdefghijklmnopqrst'] };
    await handlerFor(bot, 'check_channel:q:cabcdefghijklmnopqrst')(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0] as [string, { entities?: unknown }];
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });
});

// «Я подписался» reads the config for the emoji tokens of its toasts and of
// the two messages it may send — reads the button did not make before its
// operator copy was rendered, and they come before the spinner stops. Updates
// are handled one at a time, and a config read past the cache's TTL waits for
// the panel: the transport's ten seconds when it hangs.
describe('check_channel while the config read hangs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function registerHanging(adminClient: unknown): FakeBot {
    const bot = buildFakeBot();
    const { deps } = buildDeps(adminClient !== null ? { adminOverrides: adminClient as Record<string, unknown> } : {});
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], {
      ...deps,
      getConfig: () => new Promise<BotConfig>(() => undefined),
    });
    return bot;
  }

  it('by somebody still outside: the toast within a quarter second, and the message with it', async () => {
    vi.useFakeTimers();
    const bot = registerHanging(channelPolicyAdmin());
    const ctx = buildApiCtx(vi.fn().mockResolvedValue({ status: 'left' }));
    void handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({ text: 'ru:channel.not_subscribed' });
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('ru:channel.not_subscribed', {});
  });

  it('under RESTRICTED: the refusal alert within a quarter second', async () => {
    vi.useFakeTimers();
    const bot = registerHanging({ system: { getPlatformPolicy: vi.fn().mockResolvedValue({ accessMode: 'RESTRICTED' }) } });
    const ctx = buildApiCtx(vi.fn());
    void handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({ text: 'ru:access_mode.restricted', show_alert: true });
  });

  it('carrying a quest the user has no account for: the toast within a quarter second, «link your Telegram first» within a second more', async () => {
    vi.useFakeTimers();
    const bot = registerHanging({
      system: { getPlatformPolicy: vi.fn().mockResolvedValue({ accessMode: 'PUBLIC' }) },
      quests: {
        channelTarget: vi.fn().mockRejectedValue(Object.assign(new Error('not linked'), { status: 404 })),
      },
    });
    const ctx = { ...buildApiCtx(vi.fn()), match: ['check_channel:q:cabcdefghijklmnopqrst', 'cabcdefghijklmnopqrst'] };
    void handlerFor(bot, 'check_channel:q:cabcdefghijklmnopqrst')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({ text: 'ru:channel.verified' });
    // A message of its own, asked for at its answer: a message's budget.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('ru:quests.channel.link_first', {});
  });

  // The config the bot already holds — stale, but the operator's — renders the
  // toast and the message: a read the panel is slow to answer must not strip
  // their emoji.
  it('by somebody still outside: the toast and the message from the config the bot holds', async () => {
    vi.useFakeTimers();
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: channelPolicyAdmin() as unknown as Record<string, unknown> });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['channel.not_subscribed']),
      getConfig: () => new Promise<BotConfig>(() => undefined),
      peekConfig: () => operatorEmojiConfig(),
    });
    const ctx = buildApiCtx(vi.fn().mockResolvedValue({ status: 'left' }));
    void handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({ text: OPERATOR_TEXT_GLYPHS });
    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith(OPERATOR_TEXT_GLYPHS, { entities: [FIRE_ENTITY] });
  });

  // Telegram is asked about the membership before the toast is due. The config
  // is asked for AT the toast: one the panel gives meanwhile is the one used.
  it('asks for the config at the toast, not before asking Telegram', async () => {
    vi.useFakeTimers();
    const later = <T,>(ms: number, value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(value), ms);
      });
    // The panel answers the config read 400 ms after the press, whoever asks.
    const configRead = later(400, operatorEmojiConfig());
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: channelPolicyAdmin() as unknown as Record<string, unknown> });
    registerMenuPage(bot as unknown as Parameters<typeof registerMenuPage>[0], {
      ...deps,
      translator: withOperatorText(deps.translator, ['channel.not_subscribed']),
      getConfig: () => configRead,
    });
    const ctx = buildApiCtx(vi.fn(() => later(300, { status: 'left' })));
    void handlerFor(bot, 'check_channel')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(700);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({ text: OPERATOR_TEXT_GLYPHS });
  });
});
