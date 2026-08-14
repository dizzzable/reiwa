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
import { renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';
import type { PageDeps, PageRegistrar } from './types.js';

/**
 * Resolve the operator's `{{KEY}}` / `:slug:` tokens on a locale-picker label
 * and promote a leading premium token to `icon_custom_emoji_id`.
 *
 * These are plain callback buttons, not built-in system buttons — the panel
 * exposes no per-button icon slot for them — so `renderButtonLabel` is the
 * right renderer here, not `renderSystemButton`.
 */
function localeButton(
  label: string,
  botCfg: Awaited<ReturnType<PageDeps['getConfig']>>,
): { text: string } | { text: string; icon_custom_emoji_id: string } {
  const rendered = renderButtonLabel(
    label,
    botCfg.botEmojis,
    botCfg.customEmojis,
    botCfg.botEmojiOwnerHasPremium ?? true,
  );
  return rendered.iconCustomEmojiId !== undefined
    ? { text: rendered.text, icon_custom_emoji_id: rendered.iconCustomEmojiId }
    : { text: rendered.text };
}

export const registerLangPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, adminClient, getConfig } = deps;

  bot.command('lang', async (ctx) => {
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await getConfig();
    const kb = new InlineKeyboard()
      .text(localeButton(translator.t('lang.ru', lang), botCfg), 'lang:ru')
      .text(localeButton(translator.t('lang.en', lang), botCfg), 'lang:en');
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
      adminClient.user
        .updateLanguage({ telegramId: String(userId) }, newLang)
        .catch(() => {
          /* swallow */
        });
    }

    const langName = translator.t(`lang.name.${newLang}`, newLang);
    await ctx.reply(translator.t('lang.changed', newLang, { lang: langName }));
  });
};
