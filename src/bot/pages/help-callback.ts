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
import { renderBotCopy, renderBotCopyHtml, renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import {
  applyScreenTemplate,
  appendBackToMenuRow,
  buildScreenKeyboard,
  findScreenByName,
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
    // HTML screens render the operator's markup via parse_mode; otherwise the
    // entity-based render keeps premium custom-emoji working.
    const useHtml = overrideScreen?.parseMode === 'html';
    const sendCopy = (body: string, kb: InlineKeyboard): Promise<void> => {
      if (useHtml) {
        return editOrReply(ctx, {
          text: renderBotCopyHtml(body, botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium),
          parseMode: 'HTML',
          replyMarkup: kb,
        });
      }
      const rendered = renderBotCopy(body, botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium);
      return editOrReply(ctx, { text: rendered.text, entities: rendered.entities, replyMarkup: kb });
    };

    // Operator's own custom buttons (if any) render FIRST; the system
    // buttons (contact + back) are appended below. Previously the custom
    // buttons were dropped whenever a built-in screen added system buttons.
    const hasCustomButtons = (overrideScreen?.buttons.length ?? 0) > 0;
    const buildKeyboard = (): InlineKeyboard =>
      overrideScreen
        ? buildScreenKeyboard(overrideScreen, lang, urls.publicWebUrl, urls.miniAppUrl, {
            botEmojis: botCfg.botEmojis,
            customEmojis: botCfg.customEmojis,
            ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
          })
        : new InlineKeyboard();

    if (handle.length > 0 && !NUMERIC_HANDLE.test(handle)) {
      const prefill = translator.t('help.contact_prefill', lang);
      const supportUrl = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(prefill)}`;
      const kb = buildKeyboard();
      if (hasCustomButtons) kb.row();
      const contact = renderSystemButton(translator.t('help.contact_button', lang), 'help_contact', botCfg);
      kb.url(
        contact.iconCustomEmojiId !== undefined
          ? { text: contact.text, icon_custom_emoji_id: contact.iconCustomEmojiId }
          : contact.text,
        supportUrl,
      );
      const back = renderSystemButton(backLabel, 'back', botCfg);
      appendBackToMenuRow(kb, back.text, back.iconCustomEmojiId);
      await sendCopy(title, kb);
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

    const kb = buildKeyboard();
    const back = renderSystemButton(backLabel, 'back', botCfg);
    appendBackToMenuRow(kb, back.text, back.iconCustomEmojiId);
    await sendCopy(fallbackBody, kb);
  });
};
