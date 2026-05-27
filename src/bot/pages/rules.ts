/**
 * Rules callback page.
 *
 * Single grammy handler for the `rules` callback button. Renders an
 * inline button that opens the operator-configured rules link, or
 * falls back to a "rules unavailable" message when the link isn't
 * set in the platform policy.
 */
import { InlineKeyboard } from 'grammy';

import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';

import type { PageRegistrar } from './types.js';

interface PlatformPolicyMaybeRulesLink {
  readonly rulesLink?: string | null;
}

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

export const registerRulesPage: PageRegistrar = (bot, deps) => {
  const { adminClient, translator, userLocale } = deps;

  bot.callbackQuery('rules', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));

    const policy = adminClient
      ? ((await adminClient.system.getPlatformPolicy().catch(() => null)) as
          | PlatformPolicyMaybeRulesLink
          | null)
      : null;
    const link = policy?.rulesLink ?? '';
    if (link.length > 0) {
      const kb = new InlineKeyboard().url(translator.t('rules.open_button', lang), link);
      await ctx.reply(translator.t('rules.intro', lang), { reply_markup: kb });
    } else {
      await ctx.reply(translator.t('rules.unavailable', lang));
    }
  });
};
