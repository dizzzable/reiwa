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
 * Implementation:
 *   • The "Написать в поддержку" button is a real Telegram URL button —
 *     one tap and the user lands directly in the support DM with a
 *     pre-filled greeting. No intermediate screen, no second click.
 *   • The "В меню" button is a callback that re-renders the welcome
 *     screen via `menu:main`, in place (`editOrReply`), so the user
 *     never sees the chat fill up with redundant messages.
 *
 * Support-handle resolution chain (first non-empty wins):
 *   1. `BotConfig.visual.supportUsername` (admin override)
 *   2. `BOT_SUPPORT_USERNAME` env var (deploy default)
 *
 * Telegram deep-links require an `@username`. When the configured
 * handle is numeric (a chat id), `t.me/<digits>` is not a valid URL,
 * so we fall back to a plain-text "Связаться: <id>" copy with no
 * URL button. Operators should set a real username for the snoups-
 * style click-through experience.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import {
  buildScreenKeyboard,
  findScreenByName,
  pickScreenText,
} from './screen-renderer.js';
import type { PageRegistrar } from './types.js';

const NUMERIC_HANDLE = /^-?\d+$/;
const SCREEN_OVERRIDE_NAME = 'help';

export const registerHelpCallbackPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, getConfig, envSupportUsername, urls } = deps;

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await getConfig();

    // Operator override: if a screen named "help" exists in the
    // published flow, render it instead of the built-in fallback.
    const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
    if (overrideScreen !== null) {
      const text = pickScreenText(overrideScreen, lang);
      const keyboard = buildScreenKeyboard(
        overrideScreen,
        lang,
        urls.publicWebUrl,
        urls.miniAppUrl,
      );
      if (overrideScreen.buttons.length === 0) {
        keyboard.text(translator.t('back_to_menu', lang), 'menu:main');
      }
      await editOrReply(ctx, { text, replyMarkup: keyboard });
      return;
    }

    const adminHandle = botCfg.visual.supportUsername.replace(/^@+/, '').trim();
    const handle = adminHandle.length > 0 ? adminHandle : (envSupportUsername ?? '').trim();

    const title = translator.t('support.title', lang);
    const backLabel = translator.t('back_to_menu', lang);

    if (handle.length > 0 && !NUMERIC_HANDLE.test(handle)) {
      const prefill = translator.t('help.contact_prefill', lang);
      const supportUrl = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(prefill)}`;
      const kb = new InlineKeyboard()
        .url(translator.t('help.contact_button', lang), supportUrl)
        .row()
        .text(backLabel, 'menu:main');
      await editOrReply(ctx, { text: title, replyMarkup: kb });
      return;
    }

    // Numeric handle (rare — operator's chat id, no public username) —
    // surface a plain-text fallback so users at least see *something*
    // actionable.
    const fallbackBody =
      handle.length > 0
        ? `${title}\n\n${translator.t('help.contact_support', lang, { username: handle })}`
        : translator.t('support.not_configured', lang);

    const kb = new InlineKeyboard().text(backLabel, 'menu:main');
    await editOrReply(ctx, { text: fallbackBody, replyMarkup: kb });
  });
};
