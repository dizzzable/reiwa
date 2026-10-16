/**
 * `/support` — the way into the support tickets.
 *
 * It used to switch the chat into an AI-support mode: a second support that
 * answered in the bot, apart from the tickets. Clients got lost between the
 * two, and the owner retired it (16.10.2026): the AI assistant now answers
 * inside the tickets themselves (Rezeis Admin 0.9.7.76+), as ordinary
 * support. So this command only opens «Поддержка» — the Mini App's ticket
 * page, or the cabinet's in a browser when there is no Mini App.
 *
 * Not advertised in the `/` list (`BOT_COMMANDS`), as before: `/help` and the
 * menu's «Помощь» are the doors people see; this one answers whoever types it.
 *
 * The button is the one `/help` shows first («🆘 Поддержка в приложении»,
 * system key `help_open_app`), so the operator's label and emoji are the same
 * on both doors.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { replyWithOptionalBanner } from './reply-with-banner.js';
import { renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { messageCopy } from '../widgets/operator-copy.js';
import type { PageRegistrar } from './types.js';

export const SUPPORT_COMMAND = 'support';

/** `<base>/support`, when the base gives a URL Telegram will accept on a button. */
function supportPageOf(base: string | null): string | null {
  const trimmed = (base ?? '').trim();
  if (trimmed.length === 0) return null;
  const candidate = `${trimmed.replace(/\/$/, '')}/support`;
  return isTelegramSafeButtonUrl(candidate) ? candidate : null;
}

export const registerSupportCommandPage: PageRegistrar = (bot, deps) => {
  bot.command(SUPPORT_COMMAND, async (ctx) => {
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await deps.getConfig();

    // The Mini App first — the client stays in Telegram, signed in. The
    // cabinet in a browser when the operator has no Mini App.
    const miniApp = supportPageOf(deps.urls.miniAppUrl);
    const web = miniApp === null ? supportPageOf(deps.urls.publicWebUrl) : null;

    const kb = new InlineKeyboard();
    if (miniApp !== null || web !== null) {
      const open = renderSystemButton(deps.translator.t('help.open_app_button', lang), 'help_open_app', botCfg);
      const label =
        open.iconCustomEmojiId !== undefined ? { text: open.text, icon_custom_emoji_id: open.iconCustomEmojiId } : open.text;
      if (miniApp !== null) kb.webApp(label, miniApp).row();
      else if (web !== null) kb.url(label, web).row();
    }
    const back = renderSystemButton(deps.translator.t('back_to_menu', lang), 'back', botCfg);
    kb.text(
      back.iconCustomEmojiId !== undefined ? { text: back.text, icon_custom_emoji_id: back.iconCustomEmojiId } : back.text,
      'menu:main',
    );

    const body =
      miniApp !== null || web !== null
        ? deps.translator.t('support_command.text', lang)
        : deps.translator.t('support.not_configured', lang);
    await replyWithOptionalBanner(ctx, deps, botCfg, { ...messageCopy(body, botCfg), replyMarkup: kb });
  });
};
