/**
 * Referral page — `/referral` command + `referrals` callback.
 *
 * Both surfaces fetch the user's referral summary + a fresh invite
 * token in parallel and render the standard referral message via the
 * pre-built builder. The `invite` callback in `invite.ts` is a
 * narrower variant — it only sends the share link, not the stats card.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';
import { buildReferralMessage } from '../../infrastructure/bot-message/message-builder.js';

import { replyWithEntities } from './reply.js';
import type { PageRegistrar } from './types.js';

interface ReferralSummaryShape {
  readonly totalReferrals?: number;
  readonly referralsCount?: number;
  readonly qualifiedReferrals?: number;
}

interface ReferralInviteShape {
  readonly token?: string;
}

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

async function renderReferral(
  ctx: { from?: { id: number }; reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown> },
  deps: Parameters<PageRegistrar>[1],
): Promise<void> {
  const telegramId = String(ctx.from?.id ?? '');
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
  const botCfg = await deps.getConfig();

  if (!botCfg.features.referralsEnabled) {
    await ctx.reply(deps.translator.t('referral.disabled', lang));
    return;
  }

  try {
    const [summary, invite] = (await Promise.all([
      deps.adminClient
        ? deps.adminClient.referrals.getSummary(telegramId).catch(() => null)
        : Promise.resolve(null),
      deps.adminClient
        ? deps.adminClient.referrals.createInvite(telegramId).catch(() => null)
        : Promise.resolve(null),
    ])) as [ReferralSummaryShape | null, ReferralInviteShape | null];

    const inviteLink =
      invite?.token && deps.urls.publicWebUrl
        ? `${deps.urls.publicWebUrl}/ref/${invite.token}`
        : deps.translator.t('referral.link_unavailable', lang);

    const message = buildReferralMessage({
      totalReferrals: summary?.totalReferrals ?? summary?.referralsCount ?? 0,
      qualifiedReferrals: summary?.qualifiedReferrals ?? summary?.referralsCount ?? 0,
      inviteLink,
      botEmojis: botCfg.botEmojis,
    });

    await replyWithEntities(ctx, message);
  } catch {
    await ctx.reply(deps.translator.t('referral.error', lang));
  }
}

export const registerReferralPage: PageRegistrar = (bot, deps) => {
  bot.command('referral', async (ctx) => {
    await renderReferral(ctx, deps);
  });

  bot.callbackQuery('referrals', async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderReferral(ctx, deps);
  });
};
