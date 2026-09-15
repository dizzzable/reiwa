/**
 * The channel gate's join prompt — one message, sent from every door.
 *
 * «Канал обязателен» stops a non-subscriber in two layers: `/start` runs the
 * gate itself (it has work to do first — link consume, access mode, bootstrap,
 * ad attribution), and `middleware/channel-gate.ts` runs it in front of every
 * other private-chat update. Both answer with this message, built here and
 * nowhere else, so what a user is shown cannot depend on which door they came
 * through:
 *
 *   - text `channel.required`;
 *   - «📢 Перейти в канал» (`channel.join_button`) as a URL button, only when
 *     the policy resolves a join URL;
 *   - «✅ Я подписался» (`channel.check_button`) → `check_channel`, or
 *     `check_channel:q:<questId>` when the user came for a quest, so passing the
 *     gate continues to that quest instead of the menu;
 *   - both labels through `inlineButton`, so an operator's `:slug:` renders as
 *     the pack emoji instead of leaking into the caption.
 *
 * ── ONE PROMPT PER USER PER {@link CHANNEL_PROMPT_INTERVAL_MS} ─────────────
 *
 * The throttle lives HERE, next to the send, because every door has to see
 * every other door's sends. It used to live in the middleware alone, so
 * `/start` followed by a message within the interval posted two identical
 * prompts. `/start` always sends — the user asked for the bot's front door — and
 * records the send; every other door sends only when this user has not been
 * sent one, in this language, within the interval. An album of ten photos is ten
 * updates, and a user tapping through an old menu sends a callback per tap: one
 * prompt each would stack identical messages and walk into Telegram's per-chat
 * flood limit. The language is part of the memory, so a user who switched
 * language is prompted again in the one they picked — and so is the quest a
 * prompt carried: a plain prompt does not stand in for one that has to take the
 * user on to a quest. A send that failed is not remembered, so the next update
 * tries again.
 *
 * «✅ Я подписался» pressed by somebody still outside the channel gets the same
 * treatment for its `channel.not_subscribed` message: the toast every time, the
 * message at most once per interval.
 */
import { InlineKeyboard } from 'grammy';

import { TtlMap } from '../../infrastructure/channel-gate/ttl-map.js';
import { resolveChannelJoinUrl, type ChannelGatePolicy } from '../lib/channel-gate.js';
import { inlineButton } from '../widgets/inline-button.js';
import { coerceLocale } from './coerce-locale.js';
import { QUEST_ID_PATTERN, QUEST_ID_RE } from './quest-channel.js';
import type { BotContext, PageDeps } from './types.js';

/**
 * Callback data of «✅ Я подписался». The gate middleware lets it through
 * unchecked — it is the button that runs the check (`pages/menu.ts`).
 */
export const CHECK_CHANNEL_CALLBACK = 'check_channel';

/** `check_channel`, or `check_channel:q:<questId>` (at most 48 bytes, inside Telegram's 64). */
export const CHECK_CHANNEL_CALLBACK_RE = new RegExp(`^${CHECK_CHANNEL_CALLBACK}(?::q:(${QUEST_ID_PATTERN}))?$`, 'i');

/** How long a user who was sent the join prompt is not sent it again by another door. */
export const CHANNEL_PROMPT_INTERVAL_MS = 30 * 1000;

export type ChannelJoinPromptDeps = Pick<PageDeps, 'translator' | 'userLocale' | 'getConfig'>;

export interface ChannelJoinPromptOptions {
  /** Carried through «✅ Я подписался», so passing the gate continues to this quest. */
  readonly questId?: string;
}

interface SentPrompt {
  readonly lang: string;
  readonly questId: string | undefined;
}

/** The last prompt each user was sent: in which language, carrying which quest. */
const lastPrompt = new TtlMap<number, SentPrompt>({ maxEntries: 100_000 });
/** Users sent `channel.not_subscribed` by «✅ Я подписался» within the interval. */
const lastNotSubscribedNotice = new TtlMap<number>({ maxEntries: 100_000 });

/** The callback data «✅ Я подписался» carries: the quest id only when it passes the quest grammar. */
export function checkChannelCallbackData(questId?: string): string {
  return questId !== undefined && QUEST_ID_RE.test(questId)
    ? `${CHECK_CHANNEL_CALLBACK}:q:${questId}`
    : CHECK_CHANNEL_CALLBACK;
}

/**
 * Sends the join prompt, whatever was sent before, and records the send. The
 * `/start` door. Throws what `ctx.reply` throws.
 */
export async function sendChannelJoinPrompt(
  ctx: BotContext,
  deps: ChannelJoinPromptDeps,
  policy: ChannelGatePolicy,
  options: ChannelJoinPromptOptions = {},
): Promise<void> {
  const userId = ctx.from?.id ?? 0;
  const lang = coerceLocale(deps.userLocale.getSync(userId));
  // Claimed before the send, so two updates in flight cannot both prompt.
  const sent: SentPrompt = { lang, questId: options.questId };
  lastPrompt.set(userId, sent, CHANNEL_PROMPT_INTERVAL_MS);
  try {
    const botCfg = await deps.getConfig();
    const joinUrl = resolveChannelJoinUrl(policy);
    const keyboard = new InlineKeyboard();
    if (joinUrl !== null) {
      keyboard.url(inlineButton(deps.translator.t('channel.join_button', lang), botCfg), joinUrl).row();
    }
    keyboard.text(
      inlineButton(deps.translator.t('channel.check_button', lang), botCfg),
      checkChannelCallbackData(options.questId),
    );
    await ctx.reply(deps.translator.t('channel.required', lang), { reply_markup: keyboard });
  } catch (err: unknown) {
    if (lastPrompt.get(userId) === sent) lastPrompt.delete(userId);
    throw err;
  }
}

/**
 * Sends the join prompt unless this user was sent one — in this language, and
 * carrying this quest when one has to be carried — less than
 * {@link CHANNEL_PROMPT_INTERVAL_MS} ago by any door. Every door but `/start`.
 * `true` when it sent. Throws what `ctx.reply` throws.
 */
export async function sendChannelJoinPromptUnlessRecent(
  ctx: BotContext,
  deps: ChannelJoinPromptDeps,
  policy: ChannelGatePolicy,
  options: ChannelJoinPromptOptions = {},
): Promise<boolean> {
  const userId = ctx.from?.id ?? 0;
  const lang = coerceLocale(deps.userLocale.getSync(userId));
  const last = lastPrompt.get(userId);
  if (last !== undefined && last.lang === lang && (options.questId === undefined || last.questId === options.questId)) {
    return false;
  }
  await sendChannelJoinPrompt(ctx, deps, policy, options);
  return true;
}

/**
 * «✅ Я подписался» from somebody still outside the channel: `channel.not_subscribed`
 * as a message at most once per {@link CHANNEL_PROMPT_INTERVAL_MS} per user (the
 * caller answers the toast every time). Throws what `ctx.reply` throws.
 */
export async function sendNotSubscribedNoticeUnlessRecent(ctx: BotContext, deps: ChannelJoinPromptDeps): Promise<void> {
  const userId = ctx.from?.id ?? 0;
  if (lastNotSubscribedNotice.has(userId)) return;
  lastNotSubscribedNotice.set(userId, true, CHANNEL_PROMPT_INTERVAL_MS);
  try {
    await ctx.reply(deps.translator.t('channel.not_subscribed', coerceLocale(deps.userLocale.getSync(userId))));
  } catch (err: unknown) {
    lastNotSubscribedNotice.delete(userId);
    throw err;
  }
}

/** Test hook — forgets every prompt and notice sent. */
export function resetChannelJoinPromptMemory(): void {
  lastPrompt.clear();
  lastNotSubscribedNotice.clear();
}
