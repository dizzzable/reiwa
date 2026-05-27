/**
 * Promo page specs — `/promo` command + `promo` callback + message:text
 * code consumer.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerPromoPage } from '../../../src/bot/pages/promo.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

interface FakeMessageCtx {
  from?: { id: number };
  message: { text: string };
  session: { step?: string };
  reply: ReturnType<typeof vi.fn>;
}

function buildPromoMessageCtx(text: string, step?: string): FakeMessageCtx {
  return {
    from: { id: 1 },
    message: { text },
    session: { step },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function findMessageHandler(
  bot: ReturnType<typeof buildFakeBot>,
): (ctx: BotContext) => Promise<void> {
  // The promo page registers a single message:text handler via bot.on,
  // but our fake only stores commands + callbacks. We extend the fake
  // to capture bot.on calls.
  return (bot as unknown as { messageHandler?: (ctx: BotContext) => Promise<void> })
    .messageHandler!;
}

function buildPromoFakeBot(): ReturnType<typeof buildFakeBot> & {
  messageHandler?: (ctx: BotContext) => Promise<void>;
  on: (event: string, handler: (ctx: BotContext) => Promise<void>) => void;
} {
  const base = buildFakeBot() as ReturnType<typeof buildFakeBot> & {
    messageHandler?: (ctx: BotContext) => Promise<void>;
    on?: (event: string, handler: (ctx: BotContext) => Promise<void>) => void;
  };
  base.on = (event, handler) => {
    if (event === 'message:text') base.messageHandler = handler;
  };
  return base as ReturnType<typeof buildFakeBot> & {
    messageHandler?: (ctx: BotContext) => Promise<void>;
    on: (event: string, handler: (ctx: BotContext) => Promise<void>) => void;
  };
}

describe('registerPromoPage', () => {
  it('registers /promo command, promo callback, and message:text handler', () => {
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps();
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    expect(bot.commandHandlers.has('promo')).toBe(true);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.messageHandler).toBeDefined();
  });

  it('replies with promo.disabled when the operator turned it off', async () => {
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, promoCodesEnabled: false },
      },
    });
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    const ctx = {
      ...buildFakeCtx(),
      session: { step: undefined as string | undefined },
    };
    await bot.commandHandlers.get('promo')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:promo.disabled');
    expect(ctx.session.step).toBeUndefined();
  });

  it('seeds session.step and prompts when promo is enabled', async () => {
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps();
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    const ctx = { ...buildFakeCtx(), session: { step: undefined as string | undefined } };
    await bot.commandHandlers.get('promo')!(ctx as unknown as BotContext);
    expect(ctx.session.step).toBe('awaiting_promo_code');
    expect(ctx.reply).toHaveBeenCalledWith('ru:promo.enter');
  });

  it('message:text handler ignores messages outside the promo flow', async () => {
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps();
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    const ctx = buildPromoMessageCtx('PROMO123', undefined);
    await findMessageHandler(bot)(ctx as unknown as BotContext);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.session.step).toBeUndefined();
  });

  it('activates a promo code via admin and replies with promo.activated on success', async () => {
    const activate = vi.fn().mockResolvedValue({ success: true, message: 'Welcome!' });
    const adminClient = ({
      promocodes: { activate },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    const ctx = buildPromoMessageCtx('  DISCOUNT20  ', 'awaiting_promo_code');
    await findMessageHandler(bot)(ctx as unknown as BotContext);
    expect(activate).toHaveBeenCalledWith('1', 'DISCOUNT20');
    expect(ctx.session.step).toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledWith('ru:promo.activated\n\nWelcome!');
  });

  it('replies with promo.failed when admin returns success=false', async () => {
    const activate = vi.fn().mockResolvedValue({ success: false });
    const adminClient = ({
      promocodes: { activate },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    const ctx = buildPromoMessageCtx('NO_GOOD', 'awaiting_promo_code');
    await findMessageHandler(bot)(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:promo.failed(code=NO_GOOD)');
  });

  it('replies with promo.error when admin throws', async () => {
    const activate = vi.fn().mockRejectedValue(new Error('upstream down'));
    const adminClient = ({
      promocodes: { activate },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildPromoFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerPromoPage(bot as unknown as Parameters<typeof registerPromoPage>[0], deps);
    const ctx = buildPromoMessageCtx('X', 'awaiting_promo_code');
    await findMessageHandler(bot)(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:promo.error(message=upstream down)');
  });
});
