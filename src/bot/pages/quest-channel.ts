/**
 * `quest_channel:<questId>` callback — the FAIL-CLOSED channel-subscription
 * quest verifier.
 *
 * This deliberately does NOT reuse the fail-open login gate (`menu.ts`). A quest
 * reward is money, so verification must be strict:
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
import { coerceLocale } from './coerce-locale.js';
import type { PageDeps, PageRegistrar } from './types.js';
import { isSubscribedMember } from '../lib/chat-membership.js';

/** CUID-shaped quest id, matching rezeis' user-reference grammar. */
const QUEST_CHANNEL_RE = /^quest_channel:([a-z][a-z0-9]{19,31})$/i;

interface ChannelTarget {
  readonly questId: string;
  readonly chatId: string;
  readonly joinUrl: string;
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
    const t = (key: string): string => deps.translator.t(key, lang);

    if (tgUser === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const questId = readQuestId(ctx.match);
    if (questId === null || deps.adminClient === null) {
      await ctx.answerCallbackQuery({ text: t('quests.channel.retry'), show_alert: true });
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
        await ctx.answerCallbackQuery({ text: t('quests.channel.link_first'), show_alert: true });
      } else {
        await ctx.answerCallbackQuery({ text: t('quests.channel.retry'), show_alert: true });
      }
      logWarn(deps, err, telegramId, questId, 'channelTarget failed');
      return;
    }

    // 2. Fresh membership probe against the server-derived chat id.
    let member: { status: string; is_member?: boolean };
    try {
      member = await ctx.api.getChatMember(target.chatId, tgUser.id);
    } catch (err: unknown) {
      // FAIL CLOSED: a Telegram error is never a completion.
      await ctx.answerCallbackQuery({ text: t('quests.channel.retry'), show_alert: true });
      logWarn(deps, err, telegramId, questId, 'getChatMember failed');
      return;
    }

    if (!isSubscribedMember(member)) {
      await ctx.answerCallbackQuery({ text: t('quests.channel.not_subscribed'), show_alert: true });
      return;
    }

    // 3. Positive proof → record it. rezeis flips the completion to COMPLETED
    //    but issues NO reward here (claim stays a separate cabinet action).
    try {
      await deps.adminClient.quests.verifyChannel({ telegramId, questId });
    } catch (err: unknown) {
      if (isStatus(err, 404)) {
        await ctx.answerCallbackQuery({ text: t('quests.channel.link_first'), show_alert: true });
      } else {
        await ctx.answerCallbackQuery({ text: t('quests.channel.retry'), show_alert: true });
      }
      logWarn(deps, err, telegramId, questId, 'verifyChannel failed');
      return;
    }

    await ctx.answerCallbackQuery({ text: t('quests.channel.verified'), show_alert: true });
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
