/**
 * Invite callback page (referral keyboard button).
 *
 * Generates a referral invite token via admin and renders the share
 * link. Returns a "referrals disabled" message when the operator has
 * turned the feature off in the bot config.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';

import type { PageRegistrar } from './types.js';

interface ReferralInviteShape {
  readonly token?: string;
}

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

export const registerInvitePage: PageRegistrar = (bot, deps) => {
  const { adminClient, translator, userLocale, getConfig, urls } = deps;

  bot.callbackQuery('invite', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await getConfig();

    if (!botCfg.features.referralsEnabled) {
      await ctx.reply(translator.t('referral.disabled', lang));
      return;
    }

    try {
      const invite = adminClient
        ? ((await adminClient.referrals
            .createInvite(telegramId)
            .catch(() => null)) as ReferralInviteShape | null)
        : null;
      const inviteLink =
        invite?.token && urls.publicWebUrl
          ? `${urls.publicWebUrl}/ref/${invite.token}`
          : translator.t('referral.link_unavailable', lang);
      await ctx.reply(translator.t('invite.share', lang, { link: inviteLink }));
    } catch {
      await ctx.reply(translator.t('referral.error', lang));
    }
  });
};
