import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPaymentsPage } from '../../../src/bot/pages/payments.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

/**
 * Telegram Stars — the return path.
 *
 * The two halves of this flow have OPPOSITE safe defaults, and that is the
 * whole point of the file:
 *
 *   • Before `answerPreCheckoutQuery` no stars have moved. Refusing costs the
 *     buyer nothing and they can pay again; approving wrongly takes their money
 *     for something we may not deliver, and a Stars refund is manual and
 *     out-of-band. So EVERY unclear outcome — timeout, network error, missing
 *     payload, degraded mode — must refuse.
 *   • After `successful_payment` the money is already gone. Now the only bad
 *     outcome is rezeis never hearing about it, so the forward retries and a
 *     final failure is reported at `error` — the level the process reporter
 *     actually forwards to a human — carrying the charge id a manual refund
 *     would need.
 *
 * Neither handler may throw. `bot.catch` apologises by replying into a chat,
 * and a pre-checkout query has none; the throw would be swallowed there and the
 * buyer would watch a spinner until Telegram gave up on its own.
 */

function fakeLogger() {
  // Full LoggerPort, not a convenient subset: `PageDeps.logger` is typed and a
  // partial double would only compile behind a cast that hides the next field.
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function preCheckoutCtx(invoicePayload: string) {
  return {
    from: { id: 42 },
    preCheckoutQuery: { id: 'pcq-1', invoice_payload: invoicePayload },
    answerPreCheckoutQuery: vi.fn(async () => true),
  };
}

function successCtx(over: { payload?: string; chargeId?: string } = {}) {
  const message = {
    successful_payment: {
      invoice_payload: over.payload ?? 'pay_123',
      telegram_payment_charge_id: over.chargeId ?? 'charge_abc',
      total_amount: 150,
      currency: 'XTR',
    },
  };
  return {
    from: { id: 42 },
    message,
    update: { update_id: 7, message },
    reply: vi.fn(async () => undefined),
  };
}

function refundCtx(over: { payload?: string; chargeId?: string } = {}) {
  const message = {
    refunded_payment: {
      invoice_payload: over.payload ?? 'pay_123',
      telegram_payment_charge_id: over.chargeId ?? 'charge_abc',
      total_amount: 150,
      currency: 'XTR',
    },
  };
  return { from: { id: 42 }, message, update: { update_id: 8, message } };
}

function run(
  deps: PageDeps,
  filter: 'pre_checkout_query' | 'message:successful_payment' | 'message:refunded_payment',
) {
  const bot = buildFakeBot();
  registerPaymentsPage(bot as unknown as Parameters<typeof registerPaymentsPage>[0], deps);
  const handler = bot.updateHandlers.get(filter);
  if (handler === undefined) throw new Error(`${filter} handler was not registered`);
  return handler;
}

function depsWith(payments: Record<string, unknown>, logger = fakeLogger()) {
  const { deps } = buildDeps({ adminOverrides: { payments } });
  return { deps: { ...deps, logger } as PageDeps, logger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pre-checkout', () => {
  it('approves when rezeis says the draft is still payable', async () => {
    const resolveStarsPreCheckout = vi.fn(async () => ({ approve: true, reason: 'OK' }));
    const { deps } = depsWith({ resolveStarsPreCheckout });
    const ctx = preCheckoutCtx('pay_123');

    await run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);

    expect(resolveStarsPreCheckout).toHaveBeenCalledExactlyOnceWith('pay_123');
    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(true, undefined);
  });

  it('refuses with the reason rezeis gave, rendered in the buyer’s language', async () => {
    // The panel answers with a CODE. A Russian sentence from the panel would
    // reach an English buyer untouched, which is why the copy lives here.
    const { deps } = depsWith({
      resolveStarsPreCheckout: async () => ({ approve: false, reason: 'NOT_PAYABLE' }),
    });
    const ctx = preCheckoutCtx('pay_123');

    await run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, {
      error_message: 'ru:payments.stars.already_handled',
    });
  });

  it('refuses an invoice with no payload without asking rezeis', async () => {
    // The payload IS the link to the transaction. With none there is nothing to
    // look up, and asking anyway would spend part of the ten-second budget to
    // arrive at the same refusal.
    const resolveStarsPreCheckout = vi.fn(async () => ({ approve: true, reason: 'OK' }));
    const { deps } = depsWith({ resolveStarsPreCheckout });
    const ctx = preCheckoutCtx('   ');

    await run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);

    expect(resolveStarsPreCheckout).not.toHaveBeenCalled();
    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, {
      error_message: 'ru:payments.stars.unavailable',
    });
  });

  it('refuses rather than waiting out Telegram’s ten seconds', async () => {
    // The failure this guards is silent and expensive: with no deadline the
    // handler waits on a hung panel, Telegram times the payment out on its own,
    // and the buyer is left with a spinner and no explanation.
    vi.useFakeTimers();
    const { deps } = depsWith({
      resolveStarsPreCheckout: () => new Promise(() => undefined),
    });
    const ctx = preCheckoutCtx('pay_123');

    const done = run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, {
      error_message: 'ru:payments.stars.unavailable',
    });
  });

  it('refuses with words rendered from the config the bot holds when the read does not come in time', async () => {
    vi.useFakeTimers();
    const { deps } = buildDeps({
      adminOverrides: {
        payments: { resolveStarsPreCheckout: async () => ({ approve: false, reason: 'NOT_PAYABLE' }) },
      },
    });
    const ctx = preCheckoutCtx('pay_123');

    void run(
      {
        ...deps,
        logger: fakeLogger(),
        translator: withOperatorText(deps.translator, ['payments.stars.already_handled']),
        getConfig: () => new Promise<never>(() => undefined),
        peekConfig: () => operatorEmojiConfig(),
      } as PageDeps,
      'pre_checkout_query',
    )(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, { error_message: OPERATOR_TEXT_GLYPHS });
  });

  it('refuses within a second while the config for its words hangs', async () => {
    // A refusal's words are operator copy, rendered with the config. A config
    // read past the cache's TTL waits for the panel — the transport's ten
    // seconds when it hangs, after up to five of verdict: past Telegram's own
    // ten. The words get a second, then go out as they are.
    vi.useFakeTimers();
    const { deps } = depsWith({
      resolveStarsPreCheckout: async () => ({ approve: false, reason: 'NOT_PAYABLE' }),
    });
    const ctx = preCheckoutCtx('pay_123');

    const done = run(
      { ...deps, getConfig: () => new Promise<never>(() => undefined) },
      'pre_checkout_query',
    )(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, {
      error_message: 'ru:payments.stars.already_handled',
    });
    await done;
  });

  it('refuses when rezeis is unreachable, and does not throw', async () => {
    const { deps, logger } = depsWith({
      resolveStarsPreCheckout: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const ctx = preCheckoutCtx('pay_123');

    await expect(
      run(deps, 'pre_checkout_query')(ctx as unknown as BotContext),
    ).resolves.toBeUndefined();

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses in degraded mode instead of approving a payment nobody booked', async () => {
    // No admin client means the bot cannot know whether the draft exists. The
    // buyer keeps their stars.
    const { deps } = buildDeps();
    const ctx = preCheckoutCtx('pay_123');

    await run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it('survives Telegram rejecting the answer itself', async () => {
    // The query expires after ten seconds and answering a dead one is an error.
    // Throwing here would reach `bot.catch`, which would try to reply into a
    // chat this update does not have.
    const { deps } = depsWith({
      resolveStarsPreCheckout: async () => ({ approve: true, reason: 'OK' }),
    });
    const ctx = preCheckoutCtx('pay_123');
    ctx.answerPreCheckoutQuery.mockRejectedValue(new Error('query is too old'));

    await expect(
      run(deps, 'pre_checkout_query')(ctx as unknown as BotContext),
    ).resolves.toBeUndefined();
  });
});

describe('successful payment', () => {
  it('hands rezeis the raw update, not a projection of it', async () => {
    // rezeis parses the Telegram envelope itself. Re-shaping it here would put
    // two parsers over the same money and let them disagree.
    const forwardWebhook = vi.fn(async () => ({ accepted: true }));
    const { deps } = depsWith({ forwardWebhook });
    const ctx = successCtx();

    await run(deps, 'message:successful_payment')(ctx as unknown as BotContext);

    expect(forwardWebhook).toHaveBeenCalledExactlyOnceWith('TELEGRAM_STARS', ctx.update);
    // `{}`: no emoji entities in this text, so none are sent.
    expect(ctx.reply).toHaveBeenCalledWith('ru:payments.stars.received', {});
  });

  it('sends the receipt within a second while the config for its words hangs', async () => {
    // The receipt's words are operator copy, rendered with the config — a read
    // it did not make before. Updates are handled one at a time, and a config
    // read past the cache's TTL waits for the panel: ten seconds when it hangs.
    vi.useFakeTimers();
    const forwardWebhook = vi.fn(async () => ({ accepted: true }));
    const { deps } = depsWith({ forwardWebhook });
    const ctx = successCtx();

    void run(
      { ...deps, getConfig: () => new Promise<never>(() => undefined) },
      'message:successful_payment',
    )(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('ru:payments.stars.received', {});
  });

  it('renders the receipt from the config the bot holds when the read does not come in time', async () => {
    vi.useFakeTimers();
    const { deps } = buildDeps({ adminOverrides: { payments: { forwardWebhook: vi.fn(async () => ({ accepted: true })) } } });
    const ctx = successCtx();

    void run(
      {
        ...deps,
        logger: fakeLogger(),
        translator: withOperatorText(deps.translator, ['payments.stars.received']),
        getConfig: () => new Promise<never>(() => undefined),
        peekConfig: () => operatorEmojiConfig(),
      } as PageDeps,
      'message:successful_payment',
    )(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith(OPERATOR_TEXT_GLYPHS, { entities: [FIRE_ENTITY] });
  });

  it('retries a dropped forward rather than losing the payment', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const forwardWebhook = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('socket hang up');
      return { accepted: true };
    });
    const { deps } = depsWith({ forwardWebhook });
    const ctx = successCtx();

    const done = run(deps, 'message:successful_payment')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(forwardWebhook).toHaveBeenCalledTimes(3);
    // The buyer is told it worked, because it did.
    expect(ctx.reply).toHaveBeenCalledWith('ru:payments.stars.received', {});
  });

  it('reports a payment it could not record, loudly and with the charge id', async () => {
    // The worst outcome in the whole flow: stars taken, nothing booked, draft
    // expiring as unpaid. `error` is the level the process reporter forwards to
    // a human, and the charge id is what a manual refund is done by.
    vi.useFakeTimers();
    const { deps, logger } = depsWith({
      forwardWebhook: async () => {
        throw new Error('rezeis down');
      },
    });
    const ctx = successCtx({ payload: 'pay_777', chargeId: 'charge_zzz' });

    const done = run(deps, 'message:successful_payment')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay_777', chargeId: 'charge_zzz' }),
      expect.stringContaining('NOT recorded'),
    );
    // And the buyer is told the truth rather than a cheerful lie.
    expect(ctx.reply).toHaveBeenCalledWith('ru:payments.stars.received_delayed', {});
  });

  it('still tells the buyer something when the bot has no admin client', async () => {
    const { deps, logger } = (() => {
      const logger = fakeLogger();
      const { deps } = buildDeps();
      return { deps: { ...deps, logger } as PageDeps, logger };
    })();
    const ctx = successCtx();

    await run(deps, 'message:successful_payment')(ctx as unknown as BotContext);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chargeId: 'charge_abc' }),
      expect.stringContaining('NOT recorded'),
    );
    expect(ctx.reply).toHaveBeenCalledWith('ru:payments.stars.received_delayed', {});
  });
});

// Every text here is a translator key «Тексты бота» can override, with the
// panel's emoji picker in the field. Telegram shows a refusal's
// `error_message` as plain text, so its tokens become glyphs; the receipt is a
// message and carries the pack emoji's entity too. Sent raw, the buyer read
// `:fire:`.
describe('the buyer reads the operator text, emoji tokens resolved', () => {
  function depsFor(payments: Record<string, unknown>, keys: readonly string[]): PageDeps {
    const { deps } = buildDeps({ adminOverrides: { payments }, config: operatorEmojiConfig() });
    return { ...deps, logger: fakeLogger(), translator: withOperatorText(deps.translator, keys) } as PageDeps;
  }

  it.each([
    ['payments.stars.unknown_invoice', 'UNKNOWN_PAYMENT'],
    ['payments.stars.already_handled', 'NOT_PAYABLE'],
  ])('a refused checkout: %s', async (key, reason) => {
    const deps = depsFor({ resolveStarsPreCheckout: async () => ({ approve: false, reason }) }, [key]);
    const ctx = preCheckoutCtx('pay_123');

    await run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, { error_message: OPERATOR_TEXT_GLYPHS });
  });

  it('a checkout refused because rezeis could not say', async () => {
    const deps = depsFor(
      {
        resolveStarsPreCheckout: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
      ['payments.stars.unavailable'],
    );
    const ctx = preCheckoutCtx('pay_123');

    await run(deps, 'pre_checkout_query')(ctx as unknown as BotContext);

    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledExactlyOnceWith(false, { error_message: OPERATOR_TEXT_GLYPHS });
  });

  it.each([
    ['payments.stars.received', async () => ({ accepted: true })],
    [
      'payments.stars.received_delayed',
      async () => {
        throw new Error('rezeis down');
      },
    ],
  ] as const)('the receipt: %s', async (key, forwardWebhook) => {
    vi.useFakeTimers();
    const deps = depsFor({ forwardWebhook }, [key]);
    const ctx = successCtx();

    const done = run(deps, 'message:successful_payment')(ctx as unknown as BotContext);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith(OPERATOR_TEXT_GLYPHS, { entities: [FIRE_ENTITY] });
  });
});

describe('a refunded Stars payment reaches the panel', () => {
  it('forwards the raw refund update', async () => {
    // Nothing listened for `refunded_payment`, so the update was dropped —
    // while the panel had the whole reversal path built and working. The
    // customer kept their subscription and every payout booked on money that
    // had gone back stayed booked.
    const forwardWebhook = vi.fn(async () => undefined);
    const { deps } = depsWith({ forwardWebhook });
    const ctx = refundCtx();

    await run(deps, 'message:refunded_payment')(ctx as unknown as BotContext);

    expect(forwardWebhook).toHaveBeenCalledOnce();
    // The RAW update, exactly as for a payment: the panel parses the Telegram
    // envelope itself, and a projection here would be a second parser over the
    // same money.
    expect(forwardWebhook).toHaveBeenCalledWith('TELEGRAM_STARS', ctx.update);
  });

  it('reports a refund the panel never accepted, with the charge id', async () => {
    // Same noise level as a lost payment, and for the same reason: a reversal
    // that did not land leaves payouts standing on returned money, and the
    // charge id is what a human reconciles by.
    const forwardWebhook = vi.fn(async () => {
      throw new Error('panel down');
    });
    const { deps, logger } = depsWith({ forwardWebhook });

    await run(deps, 'message:refunded_payment')(refundCtx() as unknown as BotContext);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chargeId: 'charge_abc', paymentId: 'pay_123' }),
      expect.stringContaining('NOT recorded'),
    );
  });
});
