/**
 * `/help` slash-command page (separate from the `help` keyboard
 * callback in `help-callback.ts`).
 *
 * STEALTHNET-style: a single screen with the support URL button plus
 * a "В меню" callback. We deliberately drop the long /list of /
 * commands the previous implementation rendered — Telegram already
 * surfaces the command list via the `/` autocomplete bubble (set up
 * via `setMyCommands` in bot/main.ts), so duplicating it inline is
 * just noise.
 *
 * Support-handle resolution chain (first non-empty wins):
 *   1. `BotConfig.visual.supportUsername` (admin override)
 *   2. `BOT_SUPPORT_USERNAME` env var (deploy default)
 *
 * Numeric handles (chat ids) get a plain-text fallback because
 * `t.me/<digits>` is not a valid deep-link.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { replyWithOptionalBanner } from './reply-with-banner.js';
import { renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import type { PageRegistrar } from './types.js';

const NUMERIC_HANDLE = /^-?\d+$/;

export const registerHelpCommandPage: PageRegistrar = (bot, deps) => {
  bot.command('help', async (ctx) => {
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await deps.getConfig();

    const adminHandle = botCfg.visual.supportUsername.replace(/^@+/, '').trim();
    const handle =
      adminHandle.length > 0 ? adminHandle : (deps.envSupportUsername ?? '').trim();
    const backLabel = deps.translator.t('back_to_menu', lang);
    const title = deps.translator.t('support.title', lang);

    // Resolve the in-app Support page (Mini App) deep-link once — shared by
    // both branches. `null` when no Mini App URL is configured / unsafe.
    const supportPageUrl = ((): string | null => {
      const appBase = (deps.urls.miniAppUrl ?? '').trim();
      if (appBase.length === 0) return null;
      const candidate = `${appBase.replace(/\/$/, '')}/support`;
      return isTelegramSafeButtonUrl(candidate) ? candidate : null;
    })();
    const appBtn = supportPageUrl !== null
      ? renderSystemButton(deps.translator.t('help.open_app_button', lang), 'help_open_app', botCfg)
      : null;

    if (handle.length > 0 && !NUMERIC_HANDLE.test(handle)) {
      const prefill = deps.translator.t('help.contact_prefill', lang);
      const supportUrl = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(prefill)}`;
      const kb = new InlineKeyboard();
      // #1 in-app Support page (Mini App) — no leading `.row()` so it lands on
      // the first row; subsequent buttons each open a new row.
      if (appBtn !== null && supportPageUrl !== null) {
        kb.webApp(
          appBtn.iconCustomEmojiId !== undefined
            ? { text: appBtn.text, icon_custom_emoji_id: appBtn.iconCustomEmojiId }
            : appBtn.text,
          supportPageUrl,
        );
        kb.row();
      }
      // #2 contact support chat + #3 back to main menu.
      // Both are the SAME system buttons the `help` callback screen renders
      // (`help-callback.ts`), so they resolve through `renderSystemButton` with
      // the same system keys — otherwise the operator's `:slug:` renders on the
      // keyboard-button screen and leaks raw on the `/help` command screen.
      const contactBtn = renderSystemButton(
        deps.translator.t('help.contact_button', lang),
        'help_contact',
        botCfg,
      );
      const backBtn = renderSystemButton(backLabel, 'back', botCfg);
      kb.url(
        contactBtn.iconCustomEmojiId !== undefined
          ? { text: contactBtn.text, icon_custom_emoji_id: contactBtn.iconCustomEmojiId }
          : contactBtn.text,
        supportUrl,
      )
        .row()
        .text(
          backBtn.iconCustomEmojiId !== undefined
            ? { text: backBtn.text, icon_custom_emoji_id: backBtn.iconCustomEmojiId }
            : backBtn.text,
          'menu:main',
        );
      await replyWithOptionalBanner(ctx, deps, botCfg, { text: title, replyMarkup: kb });
      return;
    }

    const fallbackBody =
      handle.length > 0
        ? `${title}\n\n${deps.translator.t('help.contact_support', lang, { username: handle })}`
        : deps.translator.t('support.not_configured', lang);
    const kb = new InlineKeyboard();
    if (appBtn !== null && supportPageUrl !== null) {
      kb.webApp(
        appBtn.iconCustomEmojiId !== undefined
          ? { text: appBtn.text, icon_custom_emoji_id: appBtn.iconCustomEmojiId }
          : appBtn.text,
        supportPageUrl,
      );
      kb.row();
    }
    const fallbackBack = renderSystemButton(backLabel, 'back', botCfg);
    kb.text(
      fallbackBack.iconCustomEmojiId !== undefined
        ? { text: fallbackBack.text, icon_custom_emoji_id: fallbackBack.iconCustomEmojiId }
        : fallbackBack.text,
      'menu:main',
    );
    await replyWithOptionalBanner(ctx, deps, botCfg, { text: fallbackBody, replyMarkup: kb });
  });
};
