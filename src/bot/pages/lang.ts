/**
 * Language settings page.
 *
 * Two grammy handlers:
 *   - `/lang`           — opens the locale picker (Russian / English)
 *   - callback `lang:*` — applies the picked locale, persists to admin
 *                          (fire-and-forget), confirms to the user
 *
 * Pure UX flow — no admin-side validation beyond the locale tag check
 * the persisted record gets on the rezeis-admin side. The
 * `userLocaleCache` write happens immediately so subsequent turns
 * render in the new locale even if the admin call is slow.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import type { PageRegistrar } from './types.js';

export const registerLangPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, adminClient } = deps;

  bot.command('lang', async (ctx) => {
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const kb = new InlineKeyboard()
      .text(translator.t('lang.ru', lang), 'lang:ru')
      .text(translator.t('lang.en', lang), 'lang:en');
    await ctx.reply(translator.t('lang.choose', lang), { reply_markup: kb });
  });

  bot.callbackQuery(/^lang:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const match = ctx.match;
    if (match === null || match === undefined) return;
    const newLangRaw = Array.isArray(match) ? match[1] : '';
    const newLang = coerceLocale(newLangRaw);
    const userId = ctx.from?.id ?? 0;
    userLocale.setSync(userId, newLang);

    // Persist language to the admin backend. Fire-and-forget — the
    // bot's auto-detect middleware will retry on the next turn if
    // this call fails.
    if (adminClient !== null) {
      adminClient
        .updateUserLanguage(String(userId), newLang)
        .catch(() => {
          /* swallow */
        });
    }

    const langName = translator.t(`lang.name.${newLang}`, newLang);
    await ctx.reply(translator.t('lang.changed', newLang, { lang: langName }));
  });
};
