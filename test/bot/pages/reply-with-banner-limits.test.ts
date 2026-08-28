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
