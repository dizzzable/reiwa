/**
 * `quest_channel:<questId>` callback — the FAIL-CLOSED channel-subscription
 * quest verifier.
 *
 * Two different checks meet here. The bot's channel gate («Канал обязателен»,
 * `middleware/channel-gate.ts`) stands in front of this callback like every
 * other button — with a FRESH check, because this is the button pressed right
 * after joining — so a user outside the gate's channel is stopped at its join
 * prompt before reaching this handler. That gate is fail-OPEN: a user it
 * cannot check is let in. The quest's own check below deliberately does NOT
 * reuse it. A quest reward is money, so verification must be strict:
 *   - membership is proved by a fresh `getChatMember` against the server-derived
 *     chat id (never a callback-supplied one);
 *   - only `member` / `administrator` / `creator`, or `restricted` WITH
 *     `is_member === true`, count as subscribed (Telegram marks a left/kicked
 *     restricted user with `is_member: false`);
 *   - any Telegram error, missing bot rights, or non-member status yields a
 *     retry / not-subscribed toast and never records a completion.
 *
 * The bot passes ONLY the authenticated `ctx.from.id`; rezeis resolves the
 * account and owns completion state.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { replyWithEntities } from './reply.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';
import { channelGateApiFor } from '../lib/bot-channel-gate.js';
import { isSubscribedMember } from '../lib/chat-membership.js';
import { configWithin, TOAST_CONFIG_BUDGET_MS } from '../lib/config-within.js';
import { inlineButton } from '../widgets/inline-button.js';
import { messageCopy, plainCopy } from '../widgets/operator-copy.js';

/**
 * CUID-shaped quest id, matching rezeis' user-reference grammar — the one
 * grammar every quest id in this bot is held to: this callback, the
 * `quest_channel_<id>` deep link, and the id the channel gate's prompt carries
 * (`check_channel:q:<id>`). Unanchored so it can be composed.
 */
export const QUEST_ID_PATTERN = '[a-z][a-z0-9]{19,31}';
export const QUEST_ID_RE = new RegExp(`^${QUEST_ID_PATTERN}$`, 'i');
export const QUEST_CHANNEL_RE = new RegExp(`^quest_channel:(${QUEST_ID_PATTERN})$`, 'i');

export interface ChannelTarget {
  readonly questId: string;
  readonly chatId: string;
  readonly joinUrl: string;
}

/**
 * The quest's join + verify screen: `quests.channel.prompt`, a URL button to the
 * quest's channel and «Я подписался» → `quest_channel:<id>`. Sent by the
 * `quest_channel_<id>` deep link, and by «✅ Я подписался» on a gate prompt that
 * carried the quest, so both land on the same screen.
 */
export async function replyWithQuestChannelPrompt(
  ctx: BotContext,
  deps: Pick<PageDeps, 'translator' | 'userLocale' | 'getConfig'>,
  questId: string,
  target: Pick<ChannelTarget, 'joinUrl'>,
): Promise<void> {
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
  // The same two labels the gate's prompt renders, through the same renderer —
  // otherwise an operator's `:slug:` shows on one screen and leaks on the other.
  const botCfg = await deps.getConfig();
  const keyboard = new InlineKeyboard()
    .url(inlineButton(deps.translator.t('channel.join_button', lang), botCfg), target.joinUrl)
    .row()
    .text(inlineButton(deps.translator.t('channel.check_button', lang), botCfg), `quest_channel:${questId}`);
  await replyWithEntities(ctx, messageCopy(deps.translator.t('quests.channel.prompt', lang), botCfg), {
    reply_markup: keyboard,
  });
}

function readQuestId(match: unknown): string | null {
  const raw = Array.isArray(match) ? match[0] : typeof match === 'string' ? match : '';
  const m = typeof raw === 'string' ? raw.match(QUEST_CHANNEL_RE) : null;
  return m ? m[1] : null;
}

export const registerQuestChannelPage: PageRegistrar = (bot, deps: PageDeps) => {
  bot.callbackQuery(QUEST_CHANNEL_RE, async (ctx) => {
    const tgUser = ctx.from;
    const lang = coerceLocale(deps.userLocale.getSync(tgUser?.id ?? 0));

    if (tgUser === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    // Every answer below is an alert with operator copy in it, and an alert
    // carries no entities: its emoji tokens go out as glyphs. The config for
    // them — a read the button made none of before — is asked for AT the
    // alert, after the quest was checked: a config the panel gives meanwhile is
    // the one used. A refresh against a hung panel must not hold the spinner,
    // and every update queued behind it: past the budget, the config the bot holds.
    const alert = async (key: string): Promise<void> => {
      const botCfg = await configWithin(deps, TOAST_CONFIG_BUDGET_MS);
      await ctx.answerCallbackQuery({ text: plainCopy(deps.translator.t(key, lang), botCfg), show_alert: true });
    };
    const questId = readQuestId(ctx.match);
    if (questId === null || deps.adminClient === null) {
      await alert('quests.channel.retry');
      return;
    }

    const telegramId = String(tgUser.id);

    // 1. Fetch the server-derived channel target (chat id + join URL). rezeis
    //    resolves the account, quest eligibility, and validated channel config.
    let target: ChannelTarget;
    try {
      target = (await deps.adminClient.quests.channelTarget({
        telegramId,
        questId,
      })) as ChannelTarget;
    } catch (err: unknown) {
      // No linked account / ineligible / bad config → guide, never verify.
      if (isStatus(err, 404)) {
        await alert('quests.channel.link_first');
      } else {
        await alert('quests.channel.retry');
      }
      logWarn(deps, err, telegramId, questId, 'channelTarget failed');
      return;
    }

    // 2. Fresh membership probe against the server-derived chat id — through
    //    the gate's short-timeout client, not `ctx.api`'s 500 seconds, which
    //    would hold every update queued behind this one.
    let member: { status: string; is_member?: boolean };
    try {
      member = await channelGateApiFor(ctx, deps).getChatMember(target.chatId, tgUser.id);
    } catch (err: unknown) {
      // FAIL CLOSED: a Telegram error is never a completion.
      await alert('quests.channel.retry');
      logWarn(deps, err, telegramId, questId, 'getChatMember failed');
      return;
    }

    if (!isSubscribedMember(member)) {
      await alert('quests.channel.not_subscribed');
      return;
    }

    // 3. Positive proof → record it. rezeis flips the completion to COMPLETED
    //    but issues NO reward here (claim stays a separate cabinet action).
    try {
      await deps.adminClient.quests.verifyChannel({ telegramId, questId });
    } catch (err: unknown) {
      if (isStatus(err, 404)) {
        await alert('quests.channel.link_first');
      } else {
        await alert('quests.channel.retry');
      }
      logWarn(deps, err, telegramId, questId, 'verifyChannel failed');
      return;
    }

    await alert('quests.channel.verified');
  });
};

function isStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === status
  );
}

function logWarn(
  deps: PageDeps,
  err: unknown,
  telegramId: string,
  questId: string,
  msg: string,
): void {
  deps.logger?.warn({ err, telegramId, questId }, `quest-channel: ${msg}`);
}
