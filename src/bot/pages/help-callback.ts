/**
 * Help callback page (the keyboard button — separate from the /help
 * slash-command which lives in `help.ts`).
 *
 * STEALTHNET-style "Поддержка" sub-menu:
 *   ┌────────────────────────────────────┐
 *   │  🆘 Написать в поддержку (URL)     │  → t.me/<handle>?text=…
 *   ├────────────────────────────────────┤
 *   │  ◀️ В меню (callback menu:main)    │  → restores welcome screen
 *   └────────────────────────────────────┘
 *
 * Operator override contract (template + system buttons):
 *   • The screen *text* may be edited in Bot Studio — operator
 *     creates/edits a screen named "help", types whatever copy they
 *     want. Placeholder `{{supportHandle}}` is replaced with the
 *     resolved support `@username` at render time.
 *   • The functional buttons (Contact-support URL + Back-to-menu) are
 *     ALWAYS appended by the bot. The operator can't break referrals
 *     / support flow by editing copy; the bot's runtime always wires
 *     the right CTAs.
 *
 * Support-handle resolution chain (first non-empty wins):
 *   1. `BotConfig.visual.supportUsername` (admin override)
 *   2. `BOT_SUPPORT_USERNAME` env var (deploy default)
 *
 * Telegram deep-links require an `@username`. When the configured
 * handle is numeric (a chat id), `t.me/<digits>` is not a valid URL,
 * so we fall back to a plain-text "Связаться: <id>" copy with no
 * URL button.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import {
  applyScreenTemplate,
  appendBackToMenuRow,
  findScreenByName,
} from './screen-renderer.js';
import type { PageRegistrar } from './types.js';

const NUMERIC_HANDLE = /^-?\d+$/;
const SCREEN_OVERRIDE_NAME = 'help';

export const registerHelpCallbackPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, getConfig, envSupportUsername } = deps;

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await getConfig();

    const adminHandle = botCfg.visual.supportUsername.replace(/^@+/, '').trim();
    const handle =
      adminHandle.length > 0 ? adminHandle : (envSupportUsername ?? '').trim();
    const backLabel = translator.t('back_to_menu', lang);
    const supportHandleDisplay = handle.length > 0 ? `@${handle}` : '';

    // Resolve title text — operator override wins, otherwise i18n
    // default. System buttons are always appended below.
    const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
    const title = overrideScreen
      ? applyScreenTemplate(overrideScreen, lang, {
          supportHandle: supportHandleDisplay,
        })
      : translator.t('support.title', lang);

    if (handle.length > 0 && !NUMERIC_HANDLE.test(handle)) {
      const prefill = translator.t('help.contact_prefill', lang);
      const supportUrl = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(prefill)}`;
      const kb = new InlineKeyboard().url(
        translator.t('help.contact_button', lang),
        supportUrl,
      );
      appendBackToMenuRow(kb, backLabel);
      await editOrReply(ctx, { text: title, replyMarkup: kb });
      return;
    }

    // Numeric handle (rare — operator's chat id, no public username) —
    // surface a plain-text fallback so users at least see *something*
    // actionable.
    const fallbackBody =
      handle.length > 0
        ? `${title}\n\n${translator.t('help.contact_support', lang, { username: handle })}`
        : overrideScreen !== null
          ? title
          : translator.t('support.not_configured', lang);

    const kb = new InlineKeyboard().text(backLabel, 'menu:main');
    await editOrReply(ctx, { text: fallbackBody, replyMarkup: kb });
  });
};
