/**
 * Telegram Stars — the return path.
 *
 * Everything else about Stars was already built in rezeis: the gateway, the
 * XTR pricing, `createInvoiceLink`, the webhook ingest, reconciliation. What
 * was missing is the half only this process can do.
 *
 * Telegram allows ONE consumer per bot token, and the bot holds it through
 * long polling. So `pre_checkout_query` and the `successful_payment` message
 * are delivered here and nowhere else — the panel's public Stars webhook
 * cannot receive them while the bot is running. With no handler on this side,
 * a Stars purchase died at pre-checkout: the query went unanswered, Telegram
 * timed out after ten seconds, and the panel never learned a thing.
 *
 * ── Who decides, who answers ──────────────────────────────────────────────
 *
 * rezeis decides — the transaction is there. This process answers — the token
 * is here. A split deployment does not guarantee the panel has a bot token at
 * all, so "let the panel call Telegram" is not an option that works everywhere.
 *
 * ── The two failure modes are not symmetrical ─────────────────────────────
 *
 * A pre-checkout that we refuse costs the buyer nothing: no stars are taken
 * and the invoice can be paid again. A pre-checkout we wrongly approve takes
 * their stars for something we may not deliver, and a Stars refund is a manual,
 * out-of-band affair. So every unclear outcome here — timeout, network error,
 * malformed payload — refuses.
 *
 * After `successful_payment` the asymmetry flips: the money is already gone,
 * and the only bad outcome left is rezeis never hearing about it. That is why
 * the forward retries, and why a final failure is reported loudly instead of
 * being swallowed like every other best-effort call in this bot.
 */
import type { PageDeps, PageRegistrar } from './types.js';
import { coerceLocale } from './coerce-locale.js';

/**
 * Bound on asking rezeis for the verdict.
 *
 * Telegram's own budget is ten seconds for the whole exchange. Five leaves room
 * for the answer call that follows, and a panel slower than this is a panel we
 * should not be taking money on behalf of.
 */
const VERDICT_BUDGET_MS = 5_000;

/** Attempts to hand `successful_payment` to rezeis before giving up loudly. */
const FORWARD_ATTEMPTS = 4;
const FORWARD_BACKOFF_MS = 400;

async function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('deadline exceeded')), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const REASON_KEY: Readonly<Record<string, string>> = {
  UNKNOWN_PAYMENT: 'payments.stars.unknown_invoice',
  NOT_PAYABLE: 'payments.stars.already_handled',
};

export const registerPaymentsPage: PageRegistrar = (bot, deps) => {
  const { adminClient, translator, userLocale, logger } = deps;
  const localeOf = (id: number | undefined) => coerceLocale(userLocale.getSync(id ?? 0));

  bot.on('pre_checkout_query', async (ctx) => {
    const lang = localeOf(ctx.from?.id);
    const query = ctx.preCheckoutQuery;
    // rezeis puts its own `paymentId` in the invoice payload at checkout, so
    // this is the only link between the query and the transaction.
    const paymentId = (query?.invoice_payload ?? '').trim();

    let approve = false;
    let reasonKey = 'payments.stars.unavailable';
    try {
      if (paymentId.length === 0) throw new Error('empty invoice payload');
      if (adminClient === null) throw new Error('degraded mode: no admin client');
      const verdict = await withDeadline(
        adminClient.payments.resolveStarsPreCheckout(paymentId),
        VERDICT_BUDGET_MS,
      );
      approve = verdict.approve;
      if (!approve) reasonKey = REASON_KEY[verdict.reason] ?? reasonKey;
    } catch (err: unknown) {
      // Deliberately not rethrown: `bot.catch` would try to apologise into a
      // chat this update does not have, and the buyer would be left staring at
      // a spinner until Telegram times the payment out on its own.
      logger?.warn({ err, paymentId }, 'bot/payments: pre-checkout verdict failed — refusing');
    }

    try {
      await ctx.answerPreCheckoutQuery(
        approve,
        approve ? undefined : { error_message: translator.t(reasonKey, lang) },
      );
    } catch (err: unknown) {
      logger?.warn({ err, paymentId }, 'bot/payments: answering the pre-checkout query failed');
    }
  });

  bot.on('message:successful_payment', async (ctx) => {
    const lang = localeOf(ctx.from?.id);
    const payment = ctx.message.successful_payment;
    const paymentId = payment.invoice_payload;

    // The RAW update, not a projection of it: rezeis parses the Telegram
    // envelope itself (`resolveTelegramPaymentPayload`), so re-shaping it here
    // would mean two parsers to keep in step over the same money.
    const forwarded = await forwardWithRetries(deps, ctx.update, {
      paymentId,
      chargeId: payment.telegram_payment_charge_id,
    });

    await ctx
      .reply(
        translator.t(
          forwarded ? 'payments.stars.received' : 'payments.stars.received_delayed',
          lang,
        ),
      )
      .catch(() => undefined);
  });
};

/**
 * Hands the payment to rezeis, retrying a few times.
 *
 * By this point the stars are gone. A dropped forward means a buyer who paid
 * and gets nothing, with the draft eventually expiring as unpaid — the one
 * outcome in this file worth being noisy about. The panel's inbox is
 * idempotent, so a retry that duplicates costs nothing.
 */
async function forwardWithRetries(
  deps: PageDeps,
  update: unknown,
  context: { readonly paymentId: string; readonly chargeId: string },
): Promise<boolean> {
  const { adminClient, logger } = deps;
  if (adminClient === null) {
    logger?.error(
      { ...context },
      'bot/payments: stars received with no admin client — payment NOT recorded',
    );
    return false;
  }

  for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt += 1) {
    try {
      await adminClient.payments.forwardWebhook('TELEGRAM_STARS', update);
      return true;
    } catch (err: unknown) {
      if (attempt === FORWARD_ATTEMPTS) {
        // `error`, not `warn`: this is the level the process error reporter
        // forwards to the operator, and an unrecorded payment needs a human.
        // `chargeId` is what a manual refund or reconciliation is done by.
        logger?.error(
          { err, ...context },
          'bot/payments: stars received but rezeis never accepted it — payment NOT recorded',
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, FORWARD_BACKOFF_MS * attempt));
    }
  }
  return false;
}
