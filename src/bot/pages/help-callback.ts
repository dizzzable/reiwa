/**
 * Help callback page (the keyboard button — separate from the /help
 * slash-command which lives in `help.ts`).
 *
 * Renders the default help intro plus, when the operator has set a
 * support username on the bot config, the "Contact support: @username"
 * line.
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

export const registerHelpCallbackPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, getConfig } = deps;

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await getConfig();
    const supportUsername = botCfg.visual.supportUsername.replace(/^@/, '');
    const lines = [
      translator.t('help.title', lang),
      translator.t('help.start', lang),
      translator.t('help.help', lang),
    ];
    if (supportUsername.length > 0) {
      lines.push('');
      lines.push(translator.t('help.contact_support', lang, { username: supportUsername }));
    }
    await ctx.reply(lines.join('\n'));
  });
};
