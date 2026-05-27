/**
 * `/help` slash-command page (separate from the `help` keyboard
 * callback in `help-callback.ts`).
 *
 * Renders a static command list, conditionally including
 * promo/referral commands when the operator has the corresponding
 * features enabled.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';

import type { PageRegistrar } from './types.js';

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

export const registerHelpCommandPage: PageRegistrar = (bot, deps) => {
  bot.command('help', async (ctx) => {
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await deps.getConfig();
    const { features } = botCfg;

    const lines = [
      deps.translator.t('help.title', lang),
      deps.translator.t('help.start', lang),
      deps.translator.t('help.subscription', lang),
      deps.translator.t('help.plans', lang),
    ];
    if (features.promoCodesEnabled) lines.push(deps.translator.t('help.promo', lang));
    if (features.referralsEnabled) lines.push(deps.translator.t('help.referral', lang));
    lines.push(deps.translator.t('help.profile', lang));
    lines.push(deps.translator.t('help.lang', lang));
    lines.push(deps.translator.t('help.help', lang));

    await ctx.reply(lines.join('\n'));
  });
};
