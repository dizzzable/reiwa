/**
 * Invite callback page (referral keyboard button).
 *
 * STEALTHNET-style referral screen rendered in place via `editOrReply`.
 * Three rows of buttons under a multi-line invitation copy:
 *
 *   ┌────────────────────────────────────┐
 *   │  📤 Поделиться в Telegram          │  → t.me/share/url?...  (forward picker)
 *   ├────────────────────────────────────┤
 *   │  📋 Скопировать ссылку             │  → copy_text  (one-tap clipboard)
 *   ├────────────────────────────────────┤
 *   │  ◀️ В меню                         │  → menu:main  (back to welcome)
 *   └────────────────────────────────────┘
 *
 * The link itself is also embedded in the message body so users can
 * long-press it for the native chooser. When the operator hasn't set
 * up `referralsEnabled` or the admin invite endpoint fails, we
 * degrade gracefully to a plain "feature unavailable" copy with just
 * the back button — never leave the user staring at a broken menu.
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

const SCREEN_OVERRIDE_NAME = 'invite';

interface ReferralInviteShape {
  readonly invite?: { readonly token?: string };
  readonly token?: string;
}

export const registerInvitePage: PageRegistrar = (bot, deps) => {
  const { adminClient, translator, userLocale, getConfig, urls } = deps;

  bot.callbackQuery('invite', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const backLabel = translator.t('back_to_menu', lang);
    const botCfg = await getConfig();

    if (!botCfg.features.referralsEnabled) {
      const kb = new InlineKeyboard().text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('referral.disabled', lang),
        replyMarkup: kb,
      });
      return;
    }

    let inviteLink: string | null = null;
    try {
      const response = adminClient
        ? ((await adminClient.referrals
            .createInvite({ telegramId })
            .catch(() => null)) as ReferralInviteShape | null)
        : null;
      // The admin endpoint wraps the invite under `{ invite: { token } }`
      // (see rezeis-admin's `ReferralsService.createInvite`). Older
      // payload shapes used a flat `{ token }`; accept both for forward
      // compatibility.
      const token = response?.invite?.token ?? response?.token ?? null;
      if (token !== null && urls.publicWebUrl !== null) {
        inviteLink = `${urls.publicWebUrl}/ref/${token}`;
      } else if (token !== null) {
        // No public web URL configured (dev-only) — fall back to a bot
        // deep-link so the share button still works.
        const botUsername = ctx.me.username;
        inviteLink = `https://t.me/${botUsername}?start=ref_${token}`;
      }
    } catch (err: unknown) {
      deps.logger?.warn(
        { err, telegramId },
        'invite: createInvite admin call threw',
      );
      const kb = new InlineKeyboard().text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('referral.error', lang),
        replyMarkup: kb,
      });
      return;
    }

    if (inviteLink === null) {
      deps.logger?.warn(
        { telegramId, hasPublicUrl: urls.publicWebUrl !== null },
        'invite: link unavailable — admin returned no token or public URL missing',
      );
      const kb = new InlineKeyboard().text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('referral.link_unavailable', lang),
        replyMarkup: kb,
      });
      return;
    }

    // Resolve the screen text — operator override wins, otherwise we
    // fall back to the i18n template. Either way the runtime-only
    // system buttons (Share + Copy) get appended below; that's the
    // contract Bot Studio promises operators ("you edit text, the
    // bot keeps working").
    const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
    const text = overrideScreen
      ? applyScreenTemplate(overrideScreen, lang, { link: inviteLink })
      : translator.t('invite.share', lang, { link: inviteLink });

    const sharePrompt = translator.t('invite.share_prompt', lang);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(sharePrompt)}`;

    const kb = new InlineKeyboard()
      .url(translator.t('invite.share_button', lang), shareUrl)
      .row()
      .copyText(translator.t('invite.copy_button', lang), inviteLink);
    appendBackToMenuRow(kb, backLabel);

    await editOrReply(ctx, { text, replyMarkup: kb });
  });
};
