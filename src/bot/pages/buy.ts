/**
 * Buy callback page — opens the Mini App's `/plans` route via a
 * single-button web_app inline keyboard. Falls back to a "use /plans"
 * hint when the Mini App is disabled.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import type { PageRegistrar } from './types.js';

export const registerBuyPage: PageRegistrar = (bot, deps) => {
  bot.callbackQuery('buy', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await deps.getConfig();

    const plansUrl =
      botCfg.features.miniAppEnabled && deps.urls.miniAppUrl
        ? `${deps.urls.miniAppUrl}/plans`
        : null;

    if (plansUrl !== null) {
      await ctx.reply(deps.translator.t('plans.open_app', lang), {
        reply_markup: new InlineKeyboard().webApp(
          deps.translator.t('plans.open_app_button', lang),
          plansUrl,
        ),
      });
    } else {
      await ctx.reply(deps.translator.t('plans.use_command', lang));
    }
  });
};
