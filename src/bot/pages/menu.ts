/**
 * Menu callbacks — `back_to_menu` + `check_channel`.
 *
 * Both rebuild the main keyboard via the bot/widgets/main-keyboard
 * widget and reply with `menu.choose_action` / `channel.verified`.
 *
 * `check_channel` is «✅ Я подписался» on the channel gate's join prompt, and
 * the callback the gate middleware (`middleware/channel-gate.ts`) lets through
 * unchecked: it runs the check itself, fresh. When the user is not a member the
 * keyboard reply is suppressed: a `channel.not_subscribed` toast on every press,
 * the same words as a message at most once per prompt interval. A user the
 * check cannot verify is let in — Telegram occasionally 502s on getChatMember,
 * and a bot that is not a channel administrator is refused outright — and the
 * gate module tells the operator why. Before asking anybody it applies the
 * access mode as `/start` does (`accessModeRefusal`): under RESTRICTED the same
 * "service unavailable" alert `menu:main` answers, and under INVITED /
 * REG_BLOCKED the refusal `/start` gives a newcomer. The gate hands this button
 * to everyone it stops, so without the check it was a way onto the welcome
 * screen of a service that is closed, or that has just refused them. A prompt that
 * carried a quest (`check_channel:q:<id>`) continues to that quest's screen
 * instead of the welcome screen, and falls back to the welcome screen when the
 * quest cannot be read. `back_to_menu` is behind the middleware like every other
 * button.
 *
 * Both answer only in the user's own chat with the bot: the screens they send
 * carry the user's fresh sign-in token, and a button pressed on a message in a
 * group must not post that token there.
 *
 * Both flows mint a fresh bot-signin token so the Cabinet URL button
 * keeps the magic-link UX consistent across `/start` and warm
 * navigation. Without it, a user who hits `back_to_menu` after their
 * 5-min token expired would silently fall through to /sign-in.
 */
import type { AdminClient } from '../../lib/admin-client.js';
import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import { buildMainKeyboard, resolveSupportDeepLink } from '../widgets/main-keyboard.js';
import { channelGateApiFor, channelGateDepsOf, isOwnPrivateChat } from '../lib/bot-channel-gate.js';
import { resolveChannelGateVerdict } from '../lib/channel-gate.js';

import { CHECK_CHANNEL_CALLBACK_RE, sendNotSubscribedNoticeUnlessRecent } from './channel-join-prompt.js';
import { coerceLocale } from './coerce-locale.js';
import { replyWithQuestChannelPrompt, type ChannelTarget } from './quest-channel.js';
import { accessModeRefusal, sendWelcomeScreen } from './start.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';

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
    // The menu carries the user's fresh sign-in token: only in their own chat
    // with the bot, never on a message in a group.
    if (tgUser === undefined || !isOwnPrivateChat(ctx)) return;
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
      botEmojis: botCfg.botEmojis,
      customEmojis: botCfg.customEmojis,
      ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
    });
    await ctx.reply(deps.translator.t('menu.choose_action', lang), {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(CHECK_CHANNEL_CALLBACK_RE, async (ctx) => {
    const tgUser = ctx.from;
    // A pass ends on the welcome screen and its sign-in token: only in the user's
    // own chat. A gate prompt posted into a group before /start stayed private
    // still carries this button there.
    if (tgUser === undefined || !isOwnPrivateChat(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
    // grammY puts the trigger's match here: group 1 is the carried quest id.
    const questId = Array.isArray(ctx.match) ? (ctx.match[1] as string | undefined) : undefined;

    const policy = deps.adminClient
      ? await getPolicyCache(deps.adminClient).get().catch(() => null)
      : null;
    // The access mode `/start` applies, and before Telegram is asked. RESTRICTED:
    // the same refusal `menu:main` answers — nothing past this button may be
    // reached while the service is closed. INVITED / REG_BLOCKED: a newcomer
    // `/start` refused holds this button too, because the gate middleware sends
    // its prompt to everybody it stops, and a pass must not open the welcome
    // screen of a service that refused them.
    const refusal =
      policy === null || deps.adminClient === null
        ? null
        : await accessModeRefusal(deps.adminClient, policy, tgUser.id, '');
    if (refusal !== null) {
      await ctx.answerCallbackQuery({
        text: deps.translator.t(refusal, lang),
        show_alert: true,
      });
      return;
    }
    // Never throws. A user it cannot verify is let in — locking somebody out on
    // a Telegram refusal is the wrong call — and the operator is told why.
    //
    // `fresh`: pressing «Я подписался» says something changed, so a remembered
    // "not subscribed" is skipped — one who just joined must not be refused on a
    // memo. Under «Перепроверять подписку» OFF a pass is still honoured: checked
    // at the first entry only.
    const verdict =
      policy === null
        ? 'off'
        : await resolveChannelGateVerdict(
            channelGateApiFor(ctx, deps),
            policy,
            tgUser.id,
            channelGateDepsOf(deps),
            { fresh: true },
          );
    if (verdict === 'not-subscribed') {
      // The toast on every press; the message at most once per prompt interval.
      await ctx.answerCallbackQuery({ text: deps.translator.t('channel.not_subscribed', lang) });
      await sendNotSubscribedNoticeUnlessRecent(ctx, deps).catch((err: unknown) => {
        // The toast already said it; a notice that failed is forgotten, and the next press sends it.
        deps.logger?.warn({ err, telegramId: tgUser.id }, 'bot/menu: the not-subscribed notice could not be sent');
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: deps.translator.t('channel.verified', lang) });
    if (questId !== undefined && deps.adminClient !== null && (await continuedToQuest(ctx, deps, deps.adminClient, questId))) {
      return;
    }
    // Channel check passed — render the FULL welcome screen (banner + greeting
    // + keyboard), identical to /start. Previously this sent a bare keyboard with
    // no banner, so users had to re-/start to see the branded welcome.
    await sendWelcomeScreen(ctx, deps);
  });
};

/**
 * After a gate prompt that carried a quest: the quest's own join + verify
 * screen, exactly as the `quest_channel_<id>` deep link shows it — the user came
 * for the quest, and passing the gate is only the first half of it.
 *
 * `false` when the quest cannot be shown, and the caller falls back to the
 * welcome screen: answering "try again" with nothing else left the user on a
 * dead end that pressing the button again only repeated. A 404 (no account
 * linked to this Telegram) says so first, as the quest's verify button does.
 */
async function continuedToQuest(
  ctx: BotContext,
  deps: PageDeps,
  adminClient: AdminClient,
  questId: string,
): Promise<boolean> {
  const telegramId = ctx.from?.id ?? 0;
  let target: ChannelTarget;
  try {
    target = (await adminClient.quests.channelTarget({ telegramId: String(telegramId), questId })) as ChannelTarget;
  } catch (err: unknown) {
    deps.logger?.warn({ err, telegramId, questId }, 'bot/menu: quest_channel target failed after the channel gate');
    if (isStatus(err, 404)) {
      await ctx.reply(deps.translator.t('quests.channel.link_first', coerceLocale(deps.userLocale.getSync(telegramId))));
    }
    return false;
  }
  await replyWithQuestChannelPrompt(ctx, deps, questId, target);
  return true;
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;
}
