/**
 * Promo page — `/promo` command + `promo` callback + `message:text`
 * handler that consumes the promo code typed by the user.
 *
 * Three coordinated handlers because the promo flow is a one-step
 * conversation: command/callback set `session.step = 'awaiting_promo_code'`
 * and prompt the user; the next text message consumes the code and
 * dispatches the activation against the admin API.
 *
 * Wave 1B ships @grammyjs/conversations + @grammyjs/storage-redis;
 * Wave 8 will rewire this onto a typed conversation. Until then the
 * `session.step` string slot keeps the legacy contract intact.
 */
import { coerceLocale } from './coerce-locale.js';
import type { PageRegistrar } from './types.js';

interface PromocodeResultShape {
  readonly activated?: boolean;
  readonly success?: boolean;
  readonly message?: string;
}

async function startPromoFlow(
  ctx: {
    from?: { id: number };
    reply: (text: string) => Promise<unknown>;
    session: { step?: string };
  },
  deps: Parameters<PageRegistrar>[1],
): Promise<void> {
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
  const botCfg = await deps.getConfig();
  if (!botCfg.features.promoCodesEnabled) {
    await ctx.reply(deps.translator.t('promo.disabled', lang));
    return;
  }
  ctx.session.step = 'awaiting_promo_code';
  await ctx.reply(deps.translator.t('promo.enter', lang));
}

export const registerPromoPage: PageRegistrar = (bot, deps) => {
  bot.command('promo', async (ctx) => {
    await startPromoFlow(ctx, deps);
  });

  bot.callbackQuery('promo', async (ctx) => {
    await ctx.answerCallbackQuery();
    await startPromoFlow(ctx, deps);
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'awaiting_promo_code') {
      // Not in promo-flow context — yield to the rest of the
      // middleware stack so command handlers (`/start`, `/help`, etc.)
      // and other text matchers still see the message. Without this
      // call, ALL non-promo text messages would be silently swallowed.
      return next();
    }
    ctx.session.step = undefined;
    const code = ctx.message.text.trim();
    const telegramId = String(ctx.from?.id ?? '');
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));

    try {
      const result = deps.adminClient
        ? ((await deps.adminClient.promocodes.activate(
            telegramId,
            code,
          )) as PromocodeResultShape | null)
        : null;

      if (result?.activated === true || result?.success === true) {
        const trailer = result.message ?? '';
        await ctx.reply(`${deps.translator.t('promo.activated', lang)}\n\n${trailer}`);
      } else {
        await ctx.reply(deps.translator.t('promo.failed', lang, { code }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(deps.translator.t('promo.error', lang, { message }));
    }
  });
};
