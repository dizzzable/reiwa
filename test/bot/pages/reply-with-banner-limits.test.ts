import { describe, expect, it, vi } from 'vitest';

import { replyWithOptionalBanner } from '../../../src/bot/pages/reply-with-banner.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps } from './helpers.js';

/**
 * Telegram's two hard limits on a message, and what happened without them
 * ══════════════════════════════════════════════════════════════════════
 *
 * A screen's body is typed by the operator. `BotFlowScreen.textRu` defaults to
 * an empty string and its update DTO enforces neither a minimum nor a maximum,
 * so both ends of the range are reachable through the editor:
 *
 *   • empty  — `400 message text is empty`;
 *   • > 4096 — `400 message is too long`.
 *
 * Both reached the user as the generic apology, and both failed TWICE, because
 * the HTML-recovery path resends the same text without a parse mode — which
 * does nothing for a length or an emptiness error. The 1024-character CAPTION
 * cap was guarded from the start; these two were not.
 */

function buildCtx() {
  return {
    reply: vi.fn(async (_text: string, _opts?: Record<string, unknown>) => undefined),
    replyWithPhoto: vi.fn(async () => undefined),
  };
}

function deps(): PageDeps {
  const { deps: base } = buildDeps();
  return base;
}

describe('a screen with nothing in it', () => {
  it('sends nothing rather than earning "message text is empty"', async () => {
    const ctx = buildCtx();

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text: '   ',
    });

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('still sends a screen that has text', async () => {
    // Positive control: the refusal is about emptiness, not about the helper
    // having stopped sending.
    const ctx = buildCtx();

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text: 'Правила сервиса',
    });

    expect(ctx.reply).toHaveBeenCalledOnce();
  });
});

describe('a screen longer than Telegram accepts', () => {
  it('arrives in several messages instead of failing', async () => {
    const ctx = buildCtx();
    const long = Array.from({ length: 300 }, (_, i) => `Пункт ${i} правил сервиса.`).join('\n\n');
    expect(long.length).toBeGreaterThan(4096);

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text: long,
    });

    expect(ctx.reply.mock.calls.length).toBeGreaterThan(1);
    for (const [text] of ctx.reply.mock.calls) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
  });

  it('cuts on a line break, so no word and no HTML tag is split in half', async () => {
    // Splitting blind would break a word, and worse, could split a tag —
    // turning one rejected message into two.
    const ctx = buildCtx();
    const long = Array.from({ length: 300 }, (_, i) => `<b>Пункт ${i}</b> правил.`).join('\n');

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text: long,
      parseMode: 'HTML',
    });

    for (const [text] of ctx.reply.mock.calls) {
      const opens = (text.match(/<b>/g) ?? []).length;
      const closes = (text.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('puts the keyboard on the last part only', async () => {
    // A split document must still END with its buttons rather than carry them
    // in the middle.
    const ctx = buildCtx();
    const long = Array.from({ length: 300 }, (_, i) => `Пункт ${i} правил сервиса.`).join('\n\n');
    const replyMarkup = { inline_keyboard: [] } as never;

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text: long,
      replyMarkup,
    });

    const calls = ctx.reply.mock.calls;
    const withKeyboard = calls.filter(([, opts]) => opts?.['reply_markup'] !== undefined);
    expect(withKeyboard).toHaveLength(1);
    expect(calls[calls.length - 1][1]?.['reply_markup']).toBe(replyMarkup);
  });
});

/**
 * A long screen whose text carries entities — the operator's pack emoji.
 *
 * Each part is a message of its own, so it has to carry the entities that fall
 * in it at offsets counted from ITS start (UTF-16 units). They all used to ride
 * on the last part at their offsets in the whole text: out of that part's
 * range, a 400, and the user got the generic apology instead of the screen.
 *
 * And Telegram counts the 4096 in characters (code points), not in the UTF-16
 * units JavaScript's `.length` counts — see memory
 * `telegram-length-limits-count-code-points` — so a cut must never land inside
 * a surrogate pair, nor inside the glyph an entity covers.
 */
describe('a long screen with the operator’s emoji in it', () => {
  const FIRE_ID = '5368324170671202286';
  type Entity = { type: 'custom_emoji'; offset: number; length: number; custom_emoji_id: string };
  const entitiesOf = (opts: Record<string, unknown> | undefined): Entity[] =>
    (opts?.['entities'] as Entity[] | undefined) ?? [];
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('gives each part the entities that fall in it, counted from the part’s own start', async () => {
    const ctx = buildCtx();
    const lines = Array.from({ length: 300 }, (_, i) => `🔥 Пункт ${i} правил сервиса.`);
    const entities: Entity[] = [];
    let offset = 0;
    for (const line of lines) {
      entities.push({ type: 'custom_emoji', offset, length: 2, custom_emoji_id: FIRE_ID });
      offset += line.length + 2;
    }

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text: lines.join('\n\n'),
      entities,
    });

    const calls = ctx.reply.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    let carried = 0;
    for (const [part, opts] of calls) {
      const own = entitiesOf(opts);
      // Every entity sits on a 🔥 of THIS part, and every 🔥 of it carries one.
      for (const entity of own) expect(part.slice(entity.offset, entity.offset + entity.length)).toBe('🔥');
      expect(own).toHaveLength([...part.matchAll(/🔥/gu)].length);
      carried += own.length;
    }
    expect(carried).toBe(300);
  });

  it('measures the limit in characters, as Telegram does: 3000 emoji are one message', async () => {
    // 3000 characters for Telegram, 6000 UTF-16 units for `.length`.
    const ctx = buildCtx();
    const text = '😀'.repeat(3000);

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, { text });

    expect(ctx.reply.mock.calls.map(([part]) => part)).toEqual([text]);
  });

  it('never cuts a surrogate pair in half where there is no line break to cut at', async () => {
    const ctx = buildCtx();
    const text = `a${'😀'.repeat(5000)}`;

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, { text });

    const parts = ctx.reply.mock.calls.map(([part]) => part);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(LONE_SURROGATE.test(part)).toBe(false);
      expect([...part].length).toBeLessThanOrEqual(4096);
    }
    expect(parts.join('')).toBe(text);
  });

  it('never cuts the glyph an entity covers, even when the limit falls inside it', async () => {
    // A flag is two characters under one entity. Placed so the 4096th character
    // is its first half, the cut moves back to before it and the flag, whole,
    // opens the next part with its entity at 0.
    const ctx = buildCtx();
    const flag = '🇷🇺';
    const text = `${'x'.repeat(4095)}${flag}${'y'.repeat(100)}`;

    await replyWithOptionalBanner(ctx as unknown as BotContext, deps(), DEFAULT_BOT_CONFIG, {
      text,
      entities: [{ type: 'custom_emoji', offset: 4095, length: flag.length, custom_emoji_id: FIRE_ID }],
    });

    const calls = ctx.reply.mock.calls;
    expect(calls.map(([part]) => part)).toEqual(['x'.repeat(4095), `${flag}${'y'.repeat(100)}`]);
    expect(entitiesOf(calls[0][1])).toEqual([]);
    expect(entitiesOf(calls[1][1])).toEqual([
      { type: 'custom_emoji', offset: 0, length: flag.length, custom_emoji_id: FIRE_ID },
    ]);
  });
});
