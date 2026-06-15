/**
 * Menu callbacks — `back_to_menu` + `check_channel`.
 *
 * Both rebuild the main keyboard via the bot/widgets/main-keyboard
 * widget and reply with `menu.choose_action` / `channel.verified`.
 *
 * `check_channel` additionally probes channel membership via the
 * Telegram Bot API; when the user is not a member the keyboard reply
 * is suppressed and the user gets `channel.not_subscribed`. Membership
 * check failures fall through (let the user in) — Telegram occasionally
 * 502s on getChatMember and we don't want a transient outage to lock
 * legitimate users out of the bot.
 *
 * Both flows mint a fresh bot-signin token so the Cabinet URL button
 * keeps the magic-link UX consistent across `/start` and warm
 * navigation. Without it, a user who hits `back_to_menu` after their
 * 5-min token expired would silently fall through to /sign-in.
 */
import type { AdminClient } from '../../lib/admin-client.js';
import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import { buildMainKeyboard, resolveSupportDeepLink } from '../widgets/main-keyboard.js';
import {
  isChannelGateActive,
  resolveChannelChatId,
  isSubscribedStatus,
  markChannelPassed,
} from '../lib/channel-gate.js';

import { coerceLocale } from './coerce-locale.js';
import { sendWelcomeScreen } from './start.js';
import type { PageDeps, PageRegistrar } from './types.js';

/**
 * Resolve the same support URL the start page uses for the Help button.
 * Centralised here so menu callbacks render an identical keyboard to
 * the welcome screen — no UX drift between cold path (`/start`) and
 * warm paths (`back_to_menu` / `check_channel`).
 */
function resolveSupportUrlForMenu(
  deps: PageDeps,
  supportUsername: string,
  lang: ReturnType<typeof coerceLocale>,
): string | null {
  const adminHandle = supportUsername.replace(/^@+/, '').trim();
  const handle =
    adminHandle.length > 0 ? adminHandle : (deps.envSupportUsername ?? '').trim();
  return resolveSupportDeepLink(handle, deps.translator.t('help.contact_prefill', lang));
}

/**
 * Best-effort fetch a fresh bot-signin token. Mirrors `start.ts` —
 * fall back to a tokenless URL on any error so the keyboard always
 * renders.
 */
async function issueSigninToken(
  adminClient: AdminClient | null,
  telegramId: number | undefined,
  logger: PageDeps['logger'],
): Promise<string | null> {
  if (adminClient === null || telegramId === undefined) return null;
  try {
    const issued = await adminClient.webAuth.issueBotSigninToken(String(telegramId));
    return issued.token;
  } catch (err: unknown) {
    logger?.warn(
      { err, telegramId },
      'bot/menu: bot-signin token issuance failed; falling back to tokenless URL',
    );
    return null;
  }
}

export const registerMenuPage: PageRegistrar = (bot, deps) => {
  bot.callbackQuery('back_to_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgUser = ctx.from;
    if (tgUser === undefined) return;
    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));

    const botCfg = await deps.getConfig();
    const miniAppUrl =
      botCfg.features.miniAppEnabled && deps.urls.miniAppUrl !== null
        ? deps.urls.miniAppUrl
        : null;
    const signinToken = await issueSigninToken(deps.adminClient, tgUser.id, deps.logger);
    const keyboard = buildMainKeyboard({
      buttons: botCfg.buttons,
      miniAppUrl,
      publicWebUrl: deps.urls.publicWebUrl,
      lang,
      translator: deps.translator,
      supportUrl: resolveSupportUrlForMenu(deps, botCfg.visual.supportUsername, lang),
      signinToken,
    });
    await ctx.reply(deps.translator.t('menu.choose_action', lang), {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery('check_channel', async (ctx) => {
    const tgUser = ctx.from;
    if (tgUser === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));

    try {
      const policy = deps.adminClient
        ? await getPolicyCache(deps.adminClient).get().catch(() => null)
        : null;
      if (policy !== null && isChannelGateActive(policy)) {
        const chatId = resolveChannelChatId(policy);
        const member = await ctx.api.getChatMember(chatId as string | number, tgUser.id);
        if (!isSubscribedStatus(member.status)) {
          await ctx.answerCallbackQuery();
          await ctx.reply(deps.translator.t('channel.not_subscribed', lang));
          return;
        }
        markChannelPassed(tgUser.id);
      }
    } catch {
      // Can't verify — let them through. Telegram getChatMember occasionally
      // 502s; locking the user out on a transient probe is the wrong call.
    }

    // Channel check passed — confirm via toast and render the FULL welcome
    // screen (banner + greeting + keyboard), identical to /start. Previously
    // this sent a bare keyboard with no banner, so users had to re-/start to
    // see the branded welcome.
    await ctx.answerCallbackQuery({ text: deps.translator.t('channel.verified', lang) });
    await sendWelcomeScreen(ctx, deps);
  });
};
