/**
 * AI support — every text the page itself sends, with an operator's emoji
 * tokens in it.
 *
 * All of them are translator keys «Тексты бота» can override, with the panel's
 * emoji picker in the field, and none of them went through a renderer, so an
 * operator's `:slug:` reached the user as `:fire:`. Three are sent with
 * `parse_mode: 'Markdown'` (their default copy is Markdown), which rules out
 * entities: Telegram takes one or the other, and legacy Markdown has no
 * custom-emoji syntax. Those get glyphs. The two sent without a parse mode get
 * the pack emoji's entity as well, and the exit button a caption like every
 * other button's.
 *
 * The model is mocked: what it says is not the page's text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/ai/chat-client.js', () => ({
  generateResponseWithTools: vi.fn(),
}));

import { generateResponseWithTools } from '../../../src/core/ai/chat-client.js';
import { registerAiSupportPage } from '../../../src/bot/pages/ai-support.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import {
  FIRE_EMOJI_ID,
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

type Handler = (ctx: BotContext, next?: () => Promise<void>) => Promise<void>;

const generate = vi.mocked(generateResponseWithTools);

afterEach(() => {
  generate.mockReset();
});

/** A panel with the assistant switched on and a key to call it with. */
function aiAdmin(): Record<string, unknown> {
  return {
    aiConfig: {
      getSettings: vi.fn().mockResolvedValue({ apiKey: 'sk-test', baseUrl: '', model: '', enabled: true, systemPrompt: '' }),
      getInstructions: vi.fn().mockResolvedValue([]),
    },
  };
}

/**
 * The page on a fake bot that also keeps its catch-all `hears` handler, which
 * the shared fixture drops on purpose.
 */
function registerWith(
  keys: readonly string[],
  adminClient: Record<string, unknown> | null,
  getConfig?: () => Promise<BotConfig>,
  peekConfig?: () => BotConfig | null,
) {
  const fake = buildFakeBot();
  let hears: Handler | undefined;
  const bot = {
    ...fake,
    hears(_matcher: unknown, handler: Handler) {
      hears = handler;
    },
  };
  const { deps } = buildDeps({
    config: operatorEmojiConfig(),
    ...(adminClient !== null ? { adminOverrides: adminClient } : {}),
  });
  registerAiSupportPage(bot as unknown as Parameters<typeof registerAiSupportPage>[0], {
    ...deps,
    translator: withOperatorText(deps.translator, keys),
    ...(getConfig !== undefined ? { getConfig } : {}),
    ...(peekConfig !== undefined ? { peekConfig } : {}),
  });
  return {
    command: (name: string) => fake.commandHandlers.get(name) as Handler,
    callback: (data: string) => fake.callbackHandlers.find((h) => h.matcher === data)!.handler as Handler,
    hears: () => hears!,
  };
}

function ctxFor(chatId: number, session: Record<string, unknown>, text?: string) {
  return {
    from: { id: chatId },
    chat: { id: chatId, type: 'private' },
    session,
    ...(text !== undefined ? { message: { text } } : {}),
    reply: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: { sendChatAction: vi.fn().mockResolvedValue(true) },
  };
}

type Sent = [string, { parse_mode?: string; entities?: unknown; reply_markup?: { inline_keyboard: unknown[][] } }];

describe('AI support — Markdown messages: glyphs, the parse mode kept', () => {
  it('/support while the assistant is off', async () => {
    const page = registerWith(['ai_support.unavailable'], null);
    const ctx = ctxFor(501, {});
    await page.command('support')(ctx as unknown as BotContext);
    expect(ctx.reply.mock.calls).toEqual([[OPERATOR_TEXT_GLYPHS, { parse_mode: 'Markdown' }]]);
  });

  it('/support: the introduction', async () => {
    const page = registerWith(['ai_support.intro'], aiAdmin());
    const ctx = ctxFor(502, {});
    await page.command('support')(ctx as unknown as BotContext);
    expect(ctx.reply.mock.calls).toEqual([[OPERATOR_TEXT_GLYPHS, { parse_mode: 'Markdown' }]]);
  });

  it('/cancel: leaving', async () => {
    const page = registerWith(['ai_support.exited'], aiAdmin());
    const ctx = ctxFor(503, { aiSupportMode: true });
    await page.command('cancel')(ctx as unknown as BotContext, vi.fn());
    expect(ctx.reply.mock.calls).toEqual([[OPERATOR_TEXT_GLYPHS, { parse_mode: 'Markdown' }]]);
  });

  it('the exit button: leaving, in place', async () => {
    const page = registerWith(['ai_support.exited'], aiAdmin());
    const ctx = ctxFor(504, { aiSupportMode: true });
    await page.callback('ai_support_exit')(ctx as unknown as BotContext);
    expect(ctx.editMessageText.mock.calls).toEqual([[OPERATOR_TEXT_GLYPHS, { parse_mode: 'Markdown' }]]);
  });

  // Legacy Markdown reserves `_`, `*`, `` ` `` and `[`: a glyph carrying one
  // (the keycap `*️⃣`) is escaped, or it opens bold and Telegram refuses the
  // whole message; and a slug written the way that Markdown wants it written,
  // `:spark\_one:`, is a token like the raw spelling.
  it('escapes what legacy Markdown reserves, and reads a slug written escaped', async () => {
    const fake = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...operatorEmojiConfig(),
        customEmojis: {
          keycap: { id: null, fallback: '*️⃣' },
          spark_one: { id: '5203996991054432397', fallback: '✨' },
        },
      },
    });
    registerAiSupportPage(
      { ...fake, hears: () => undefined } as unknown as Parameters<typeof registerAiSupportPage>[0],
      { ...deps, translator: withOperatorText(deps.translator, ['ai_support.unavailable'], '*AI* :keycap: :spark\\_one:') },
    );
    const ctx = ctxFor(508, {});
    await (fake.commandHandlers.get('support') as Handler)(ctx as unknown as BotContext);
    expect(ctx.reply.mock.calls).toEqual([['*AI* \\*️⃣ ✨', { parse_mode: 'Markdown' }]]);
  });

  it('a question asked after the assistant was switched off', async () => {
    const page = registerWith(['ai_support.unavailable'], null);
    const ctx = ctxFor(505, { aiSupportMode: true }, 'как подключиться?');
    await page.hears()(ctx as unknown as BotContext, vi.fn());
    expect(ctx.reply.mock.calls).toEqual([[OPERATOR_TEXT_GLYPHS, { parse_mode: 'Markdown' }]]);
  });
});

describe('AI support — plain messages: the pack emoji’s entity, and the exit button', () => {
  it('an answer that could not be had', async () => {
    generate.mockRejectedValue(new Error('upstream 500'));
    const page = registerWith(['ai_support.failed', 'ai_support.exit_button'], aiAdmin());
    const ctx = ctxFor(506, { aiSupportMode: true }, 'как подключиться?');
    await page.hears()(ctx as unknown as BotContext, vi.fn());
    const [text, opts] = ctx.reply.mock.calls[0] as Sent;
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
    expect(opts.reply_markup?.inline_keyboard).toEqual([
      [{ text: 'Здравствуйте! 🎁', icon_custom_emoji_id: FIRE_EMOJI_ID, callback_data: 'ai_support_exit' }],
    ]);
  });

  it('too many questions in a row', async () => {
    generate.mockResolvedValue('ответ модели');
    const page = registerWith(['ai_support.rate_limited'], aiAdmin());
    const session = { aiSupportMode: true };
    // Fifteen a minute per chat; the sixteenth is refused.
    for (let i = 0; i < 15; i += 1) {
      await page.hears()(ctxFor(507, session, `вопрос ${i}`) as unknown as BotContext, vi.fn());
    }
    const ctx = ctxFor(507, session, 'ещё вопрос');
    await page.hears()(ctx as unknown as BotContext, vi.fn());
    const [text, opts] = ctx.reply.mock.calls[0] as Sent;
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
  });
});

// Every text of this page reads the config for its emoji tokens — reads the
// page made none of before its operator copy was rendered. Updates are handled
// one at a time, and a config read past the cache's TTL waits for the panel:
// the transport's ten seconds when it hangs. The words go out as written.
describe('AI support while the config read hangs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const hangs = (): Promise<BotConfig> => new Promise<BotConfig>(() => undefined);

  it('/support answers within a second', async () => {
    vi.useFakeTimers();
    const page = registerWith([], null, hangs);
    const ctx = ctxFor(511, {});
    void page.command('support')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply.mock.calls).toEqual([['ru:ai_support.unavailable', { parse_mode: 'Markdown' }]]);
  });

  it('/cancel answers within a second', async () => {
    vi.useFakeTimers();
    const page = registerWith([], aiAdmin(), hangs);
    const ctx = ctxFor(512, { aiSupportMode: true });
    void page.command('cancel')(ctx as unknown as BotContext, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply.mock.calls).toEqual([['ru:ai_support.exited', { parse_mode: 'Markdown' }]]);
  });

  it('a question whose answer could not be had: the apology and the exit button within a second', async () => {
    vi.useFakeTimers();
    generate.mockRejectedValue(new Error('upstream 500'));
    const page = registerWith([], aiAdmin(), hangs);
    const ctx = ctxFor(513, { aiSupportMode: true }, 'как подключиться?');
    void page.hears()(ctx as unknown as BotContext, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.reply.mock.calls[0] as Sent;
    expect(text).toBe('ru:ai_support.failed');
    expect(opts.reply_markup?.inline_keyboard).toEqual([
      [{ text: 'ru:ai_support.exit_button', callback_data: 'ai_support_exit' }],
    ]);
  });

  it('the exit button: out of support, the spinner stopped, within a quarter second', async () => {
    vi.useFakeTimers();
    const page = registerWith([], aiAdmin(), hangs);
    const ctx = ctxFor(514, { aiSupportMode: true });
    void page.callback('ai_support_exit')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.editMessageText.mock.calls).toEqual([['ru:ai_support.exited', { parse_mode: 'Markdown' }]]);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  // The config the bot already holds — stale, but the operator's — renders the
  // apology and the exit button: a read the panel is slow to answer must not
  // strip their emoji.
  it('a question whose answer could not be had: the apology and the exit button from the config the bot holds', async () => {
    vi.useFakeTimers();
    generate.mockRejectedValue(new Error('upstream 500'));
    const page = registerWith(['ai_support.failed', 'ai_support.exit_button'], aiAdmin(), hangs, () => operatorEmojiConfig());
    const ctx = ctxFor(515, { aiSupportMode: true }, 'как подключиться?');
    void page.hears()(ctx as unknown as BotContext, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.reply.mock.calls[0] as Sent;
    expect(text).toBe(OPERATOR_TEXT_GLYPHS);
    expect(opts.entities).toEqual([FIRE_ENTITY]);
    expect(opts.reply_markup?.inline_keyboard).toEqual([
      [{ text: 'Здравствуйте! 🎁', icon_custom_emoji_id: FIRE_EMOJI_ID, callback_data: 'ai_support_exit' }],
    ]);
  });

  // The model takes its time before the answer is due. The config is asked for
  // AT the answer: one the panel gives while the model thinks is the one used.
  it('asks for the config at the answer, not before the model is asked', async () => {
    vi.useFakeTimers();
    const later = <T,>(ms: number, value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(value), ms);
      });
    generate.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error('upstream 500')), 1_500);
        }),
    );
    // The panel answers the config read 2 s after the question, whoever asks.
    const configRead = later(2_000, operatorEmojiConfig());
    const page = registerWith(['ai_support.failed'], aiAdmin(), () => configRead);
    const ctx = ctxFor(516, { aiSupportMode: true }, 'как подключиться?');
    void page.hears()(ctx as unknown as BotContext, vi.fn());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect((ctx.reply.mock.calls[0] as Sent)[0]).toBe(OPERATOR_TEXT_GLYPHS);
  });
});
