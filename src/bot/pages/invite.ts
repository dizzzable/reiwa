/**
 * Invite hub (referral keyboard button).
 *
 * Rendered in place via `editOrReply`. Branches on the user's partner status:
 *
 *   • Active partner  → partner hub: balance / earned / referred summary +
 *     editable description + share link + deep-link to the cabinet partner page.
 *   • Otherwise       → referral hub: invited / subscribed / pending / points
 *     summary + editable description + share link + deep-links to the cabinet
 *     referrals + points-exchange pages.
 *
 * Money-path actions (points exchange, partner withdrawal) are NOT performed in
 * the bot — they open in the cabinet via deep-link buttons. Every probe is
 * best-effort: a failed status/summary lookup degrades to a minimal usable hub
 * (share link + back) and never leaves the user on a broken menu.
 */
import { InlineKeyboard } from 'grammy';

import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { renderBotCopy, renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';
import {
  applyScreenTemplate,
  appendBackToMenuRow,
  findScreenByName,
} from './screen-renderer.js';
import type { PageRegistrar, PageDeps, BotContext } from './types.js';

const SCREEN_OVERRIDE_NAME = 'invite';

/**
 * Build the object-form button text for a hub button: resolves `{{KEY}}` /
 * `:slug:` tokens to glyphs and promotes a leading premium token to the
 * button's `icon_custom_emoji_id` (premium owners). Inline-button text can't
 * carry custom_emoji entities, so this is how pack emoji render on hub buttons.
 */
function hubButton(
  raw: string,
  botCfg: Awaited<ReturnType<PageDeps['getConfig']>>,
): { text: string } | { text: string; icon_custom_emoji_id: string } {
  const r = renderButtonLabel(
    raw,
    botCfg.botEmojis,
    botCfg.customEmojis,
    botCfg.botEmojiOwnerHasPremium,
  );
  return r.iconCustomEmojiId !== undefined
    ? { text: r.text, icon_custom_emoji_id: r.iconCustomEmojiId }
    : { text: r.text };
}

interface ReferralInviteShape {
  readonly invite?: { readonly token?: string };
  readonly token?: string;
}
interface ReferralSummaryShape {
  readonly totalReferrals?: number;
  readonly qualifiedReferrals?: number;
  readonly pointsBalance?: number;
}
interface PartnerInfoShape {
  readonly balance?: number;
  readonly totalEarned?: number;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Resolve the user's share link via the admin invite endpoint. Returns `null`
 * when no token is available; falls back to a bot deep-link when no public web
 * URL is configured so the share button still works in dev.
 */
async function resolveInviteLink(
  deps: PageDeps,
  telegramId: string,
  botUsername: string | undefined,
): Promise<string | null> {
  const { adminClient, urls } = deps;
  if (!adminClient) return null;
  try {
    const response = (await adminClient.referrals
      ?.createInvite?.({ telegramId })
      ?.catch(() => null)) as ReferralInviteShape | null | undefined;
    const token = response?.invite?.token ?? response?.token ?? null;
    if (token === null) return null;
    // Prefer the Telegram deep-link in the bot — a friend who taps it opens the
    // bot directly (and `/start ref_<token>` attributes the referral). Fall back
    // to the public web `/ref/<token>` URL only when no bot username is set.
    if (botUsername) return `https://t.me/${botUsername}?start=ref_${token}`;
    if (urls.publicWebUrl !== null) return `${urls.publicWebUrl}/ref/${token}`;
    return null;
  } catch {
    return null;
  }
}

export const registerInvitePage: PageRegistrar = (bot, deps) => {
  const { adminClient, translator, userLocale, getConfig, urls } = deps;

  bot.callbackQuery('invite', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const backLabel = translator.t('back_to_menu', lang);
    const botCfg = await getConfig();

    // Active partners get the partner hub regardless of the referral toggle.
    const status = await adminClient?.partner
      ?.getStatus?.({ telegramId })
      ?.catch(() => null);
    const isPartner = (status as { isActive?: boolean } | null | undefined)?.isActive === true;

    if (!isPartner && !botCfg.features.referralsEnabled) {
      const kb = new InlineKeyboard().text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('referral.disabled', lang),
        replyMarkup: kb,
      });
      return;
    }

    const inviteLink = await resolveInviteLink(deps, telegramId, ctx.me.username);

    if (isPartner) {
      await renderPartnerHub(ctx, deps, lang, telegramId, inviteLink, backLabel, botCfg);
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

    await renderReferralHub(ctx, deps, lang, telegramId, inviteLink, backLabel, botCfg);
  });
};

async function renderReferralHub(
  ctx: BotContext,
  deps: PageDeps,
  lang: SupportedLocale,
  telegramId: string,
  inviteLink: string,
  backLabel: string,
  botCfg: Awaited<ReturnType<PageDeps['getConfig']>>,
): Promise<void> {
  const { adminClient, translator, urls } = deps;
  const t = (key: string, vars?: Record<string, string | number>) => translator.t(key, lang, vars);

  const summary = (await adminClient?.referrals
    ?.getSummary?.({ telegramId })
    ?.catch(() => null)) as ReferralSummaryShape | null | undefined;

  const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
  const parts: string[] = [];
  if (overrideScreen) {
    parts.push(applyScreenTemplate(overrideScreen, lang, { link: inviteLink }));
  } else {
    parts.push(t('referral.hub.title'));
    parts.push(t('referral.hub.description'));
  }

  const total = num(summary?.totalReferrals);
  const qualified = num(summary?.qualifiedReferrals);
  const points = num(summary?.pointsBalance);
  const stats: string[] = [];
  if (total !== null) stats.push(t('referral.hub.stat_invited', { count: total }));
  if (qualified !== null) stats.push(t('referral.hub.stat_qualified', { count: qualified }));
  if (total !== null && qualified !== null) {
    stats.push(t('referral.hub.stat_pending', { count: Math.max(0, total - qualified) }));
  }
  if (points !== null) stats.push(t('referral.hub.stat_points', { count: points }));
  if (stats.length > 0) parts.push(stats.join('\n'));

  if (!overrideScreen) parts.push(`${t('referral.hub.link_label')}\n${inviteLink}`);

  const sharePrompt = t('invite.share_prompt');
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(sharePrompt)}`;

  const kb = new InlineKeyboard()
    .url(hubButton(t('invite.share_button'), botCfg), shareUrl)
    .row()
    .copyText(renderButtonLabel(t('invite.copy_button'), botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium).text, inviteLink);
  if (isTelegramSafeButtonUrl(urls.publicWebUrl)) {
    kb.row().webApp(hubButton(t('referral.hub.open_cabinet'), botCfg), `${urls.publicWebUrl}/referrals`);
    kb.row().webApp(hubButton(t('referral.hub.open_exchange'), botCfg), `${urls.publicWebUrl}/referrals/exchange`);
  }
  appendBackToMenuRow(kb, backLabel);

  // Resolve `{{KEY}}` placeholders + `:slug:` pack tokens into premium
  // custom-emoji (operator-managed via the "Эмодзи" editor + emoji packs).
  const rendered = renderBotCopy(parts.join('\n\n'), botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium);
  await editOrReply(ctx, { text: rendered.text, entities: rendered.entities, replyMarkup: kb });
}

async function renderPartnerHub(
  ctx: BotContext,
  deps: PageDeps,
  lang: SupportedLocale,
  telegramId: string,
  inviteLink: string | null,
  backLabel: string,
  botCfg: Awaited<ReturnType<PageDeps['getConfig']>>,
): Promise<void> {
  const { adminClient, translator, urls } = deps;
  const t = (key: string, vars?: Record<string, string | number>) => translator.t(key, lang, vars);

  const info = (await adminClient?.partner
    ?.getInfo?.({ telegramId })
    ?.catch(() => null)) as PartnerInfoShape | null | undefined;
  const referrals = (await adminClient?.partner
    ?.getReferrals?.({ telegramId }, 1, 1)
    ?.catch(() => null)) as { total?: number } | null | undefined;

  const parts: string[] = [t('partner.hub.title'), t('partner.hub.description')];

  const balance = num(info?.balance);
  const earned = num(info?.totalEarned);
  const referred = num(referrals?.total);
  const stats: string[] = [];
  if (balance !== null) stats.push(t('partner.hub.stat_balance', { amount: balance }));
  if (earned !== null) stats.push(t('partner.hub.stat_earned', { amount: earned }));
  if (referred !== null) stats.push(t('partner.hub.stat_referred', { count: referred }));
  if (stats.length > 0) parts.push(stats.join('\n'));

  const kb = new InlineKeyboard();
  if (inviteLink !== null) {
    parts.push(`${t('referral.hub.link_label')}\n${inviteLink}`);
    const sharePrompt = t('invite.share_prompt');
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(sharePrompt)}`;
    kb.url(hubButton(t('invite.share_button'), botCfg), shareUrl).row().copyText(renderButtonLabel(t('invite.copy_button'), botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium).text, inviteLink);
  }
  if (isTelegramSafeButtonUrl(urls.publicWebUrl)) {
    if (inviteLink !== null) kb.row();
    kb.webApp(hubButton(t('partner.hub.open_cabinet'), botCfg), `${urls.publicWebUrl}/partner`);
  }
  appendBackToMenuRow(kb, backLabel);

  const rendered = renderBotCopy(parts.join('\n\n'), botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium);
  await editOrReply(ctx, { text: rendered.text, entities: rendered.entities, replyMarkup: kb });
}
