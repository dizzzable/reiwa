/**
 * The mandatory channel gate («Канал обязателен») in front of every bot update.
 *
 * ── WHY A MIDDLEWARE ──────────────────────────────────────────────────────
 *
 * The gate used to run in exactly two places: `/start` and the «✅ Я подписался»
 * (`check_channel`) callback. Every other handler assumed that whoever pressed
 * its button had come through `/start`, and nothing made that true: a menu
 * message from before the operator switched the gate on, a quest deep link
 * (handled ahead of `/start`'s gate), a typed `/help` — each reached its page
 * without anybody asking Telegram. The owner's decision (14.09.2026) is that the
 * gate covers every private-chat interaction, paying subscribers included. This
 * is where that happens; `bot/main.ts` registers it after the session and locale
 * middlewares and before every page.
 *
 * ── WHAT IT STOPS ─────────────────────────────────────────────────────────
 *
 * Something the USER did in their own private chat with the bot:
 *   - a message or an edit the user authored — text, media, sticker, contact,
 *     dice, game, poll, venue, location, checklist, story, and `web_app_data`
 *     (see {@link USER_AUTHORED_FIELDS});
 *   - a button pressed on a message in that chat.
 * Everything else passes by construction, not by a list of exemptions, so what
 * Telegram adds later is not gated by accident:
 *   - service messages. Telegram posts them into the chat on its own:
 *     `connected_website` when somebody signs in to the BROWSER cabinet with the
 *     Telegram widget (`data-request-access="write"`) — the browser cabinet is
 *     not gated, and a prompt would be the bot's first message to that person —
 *     `write_access_allowed`, Stars `successful_payment` / `refunded_payment`
 *     (money that has already moved: stopping one leaves a paid order undelivered
 *     or a refund unrecorded), gifts, pins;
 *   - groups, supergroups, channels, operator topics, business and guest chats;
 *   - updates with no chat: inline queries and their results, pre-checkout (ten
 *     seconds to answer) and shipping queries, poll answers, a button on an
 *     inline message;
 *   - my_chat_member, chat_member, chat_join_request.
 *
 * Inside the user's own chat these pass unchecked:
 *   - `/start` — the page runs the gate itself, after the work that has to come
 *     first (link consume, access mode, bootstrap, ad attribution);
 *   - `check_channel` (and `check_channel:q:<id>`) — it IS the check, a fresh one;
 *   - `/lang` and `lang:*` — see LANGUAGE;
 *   - `/paysupport` — Telegram's Stars terms oblige a bot that takes payments to
 *     answer it, and a buyer who left the channel still has a charge to ask about;
 *   - the ways out of AI-support mode: `ai_support_exit`, and `/cancel` while the
 *     chat is in that mode (out of it, `/cancel` does nothing and is gated like
 *     any command). Leaving a mode is not a feature, and a user the gate stops
 *     would otherwise be trapped in it until they subscribe;
 *   - `close` — the dismiss button on the operator's own cards (`pages/close.ts`).
 * The quest verify button (`quest_channel:<id>`) is gated with a FRESH check:
 * it is pressed right after joining, and a remembered "not subscribed" must not
 * refuse the user who just joined.
 *
 * ── THE ANSWER ────────────────────────────────────────────────────────────
 *
 * 'off', 'subscribed' and 'unverified' let the update go on. A user the gate
 * cannot check (bot not a channel admin, Telegram unreachable) is let in, and
 * the gate module has already told the operator why. A policy that cannot be
 * read, or no admin client at all, lets everything through too — with one log
 * line an hour, not one per update.
 *
 * 'not-subscribed' stops the update: `next()` is never called. A button is
 * answered with the `channel.not_subscribed` toast — its spinner has to stop
 * either way — and the chat gets the join prompt `/start` sends, unless another
 * door sent it within the prompt interval (`pages/channel-join-prompt.ts`). A
 * refused quest button carries its quest through the prompt.
 *
 * ── LANGUAGE ──────────────────────────────────────────────────────────────
 *
 * The picker passes. The prompt renders in the cached locale, and a Telegram
 * language that is neither ru nor en (nor be/uk/kk) falls back to
 * `DEFAULT_LOCALE`, which is Russian — so a Persian or Turkish speaker is met
 * with a Russian prompt. `/lang` is advertised in the command menu
 * (`BOT_COMMANDS`), and neither handler exposes anything the gate protects: the
 * picker, the language change, a confirmation. The prompt throttle remembers the
 * language of the last prompt, so the first gated update after a switch prompts
 * again, in the language just picked.
 */
import { Context, type MiddlewareFn } from 'grammy';
import type { Message } from 'grammy/types';

import { getPolicyCache, type CachedPolicy } from '../../infrastructure/admin-client/policy-cache.js';
import { TtlMap } from '../../infrastructure/channel-gate/ttl-map.js';
import { channelGateApiFor, channelGateDepsOf, isOwnPrivateChat } from '../lib/bot-channel-gate.js';
import { resolveChannelGateVerdict } from '../lib/channel-gate.js';
import { AI_SUPPORT_EXIT_CALLBACK, CANCEL_COMMAND, isInAiSupportMode } from '../pages/ai-support-mode.js';
import { CHECK_CHANNEL_CALLBACK_RE, sendChannelJoinPromptUnlessRecent } from '../pages/channel-join-prompt.js';
import { CLOSE_CALLBACK } from '../pages/close.js';
import { coerceLocale } from '../pages/coerce-locale.js';
import { LANG_CALLBACK_RE, LANG_COMMAND } from '../pages/lang.js';
import { PAYSUPPORT_COMMAND } from '../pages/paysupport.js';
import { QUEST_CHANNEL_RE } from '../pages/quest-channel.js';
import type { BotContext, PageDeps } from '../pages/types.js';

/** How often one "the gate cannot run" condition is logged. */
const WARN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Message fields that mean the user SENT something: grammY's content message
 * types, plus `web_app_data` — typed as a service message, but produced by the
 * user pressing a keyboard Web App button. Any other message in a private chat
 * is Telegram's own service message and passes, including one Telegram adds
 * after this list was written.
 */
export const USER_AUTHORED_FIELDS = [
  'text',
  'rich_message',
  'animation',
  'audio',
  'document',
  'live_photo',
  'paid_media',
  'photo',
  'sticker',
  'story',
  'video',
  'video_note',
  'voice',
  'contact',
  'dice',
  'game',
  'poll',
  'venue',
  'location',
  'checklist',
  'web_app_data',
] as const satisfies ReadonlyArray<keyof Message>;

/** grammY's own matchers, so an exemption means exactly what the page registers. */
const isExemptCommand = Context.has.command(['start', LANG_COMMAND, PAYSUPPORT_COMMAND]);
const isCancelCommand = Context.has.command(CANCEL_COMMAND);

function isUserAuthored(message: Message): boolean {
  return USER_AUTHORED_FIELDS.some((field) => message[field] !== undefined);
}

/**
 * `pass` — not the gate's business; `gate` — ask with the gate's memory;
 * `gate-fresh` — ask Telegram (the quest verify button).
 */
export type ChannelGateScope = 'pass' | 'gate' | 'gate-fresh';

/** Which of the three this update is. Rules in the header. */
export function channelGateScope(ctx: BotContext): ChannelGateScope {
  if (!isOwnPrivateChat(ctx)) return 'pass';
  const { message, edited_message: edited, callback_query: query } = ctx.update;

  if (message !== undefined) {
    if (!isUserAuthored(message) || isExemptCommand(ctx)) return 'pass';
    if (isCancelCommand(ctx) && isInAiSupportMode(ctx)) return 'pass';
    return 'gate';
  }

  if (edited !== undefined) return isUserAuthored(edited) ? 'gate' : 'pass';

  if (query?.message !== undefined) {
    // A business chat carries the customer's id, like the bot's own chat with them.
    if ('business_connection_id' in query.message && query.message.business_connection_id !== undefined) {
      return 'pass';
    }
    const data = query.data ?? '';
    if (
      CHECK_CHANNEL_CALLBACK_RE.test(data) ||
      LANG_CALLBACK_RE.test(data) ||
      data === CLOSE_CALLBACK ||
      data === AI_SUPPORT_EXIT_CALLBACK
    ) {
      return 'pass';
    }
    return QUEST_CHANNEL_RE.test(data) ? 'gate-fresh' : 'gate';
  }

  return 'pass';
}

export type ChannelGateMiddlewareDeps = Pick<
  PageDeps,
  'adminClient' | 'translator' | 'userLocale' | 'getConfig' | 'logger' | 'channelGate'
>;

export function createChannelGateMiddleware(deps: ChannelGateMiddlewareDeps): MiddlewareFn<BotContext> {
  const warnedAt = new TtlMap<string>({ maxEntries: 10 });

  const warnHourly = (key: string, context: object, message: string): void => {
    if (warnedAt.has(key)) return;
    warnedAt.set(key, true, WARN_INTERVAL_MS);
    deps.logger?.warn(context, message);
  };

  return async (ctx, next) => {
    const scope = channelGateScope(ctx);
    const from = ctx.from;
    if (scope === 'pass' || from === undefined) return next();

    if (deps.adminClient === null) {
      warnHourly('no-admin-client', {}, 'Channel gate: no admin client, so no platform policy — updates are not gated');
      return next();
    }
    let policy: CachedPolicy;
    try {
      policy = await getPolicyCache(deps.adminClient).get();
    } catch (err: unknown) {
      warnHourly('policy-unreadable', { err }, 'Channel gate: the platform policy could not be read — updates are let through');
      return next();
    }
    if (typeof policy !== 'object' || policy === null) {
      // `PolicyCache` reads a body that is not an object as a failed read and
      // hands out its stand-in (below), so only a cache put in its place can get
      // here. Not a policy is no gate (the gate module answers 'off'), said once.
      warnHourly(
        'policy-unreadable',
        { policy },
        'Channel gate: the policy cache handed out something that is not a policy — updates are let through',
      );
      return next();
    }
    if (policy._isFallback === true) {
      // The cache swallows the failure — no answer, or an answer that is not a
      // policy — and hands out a PUBLIC policy with the gate off; the verdict
      // below is 'off'. Said here, because nowhere else is.
      warnHourly(
        'policy-unreadable',
        {},
        'Channel gate: rezeis did not answer with a platform policy and none is cached — updates are let through',
      );
    }

    // Never throws; 'unverified' is a user it could not check, let in.
    const verdict = await resolveChannelGateVerdict(
      channelGateApiFor(ctx, deps),
      policy,
      from.id,
      channelGateDepsOf(deps),
      { fresh: scope === 'gate-fresh' },
    );
    if (verdict !== 'not-subscribed') return next();

    const lang = coerceLocale(deps.userLocale.getSync(from.id));
    if (ctx.callbackQuery !== undefined) {
      await ctx
        .answerCallbackQuery({ text: deps.translator.t('channel.not_subscribed', lang) })
        .catch((err: unknown) => {
          deps.logger?.warn({ err, telegramId: from.id }, 'Channel gate: answering a refused callback failed');
        });
    }
    const questId = scope === 'gate-fresh' ? QUEST_CHANNEL_RE.exec(ctx.callbackQuery?.data ?? '')?.[1] : undefined;
    try {
      await sendChannelJoinPromptUnlessRecent(ctx, deps, policy, questId !== undefined ? { questId } : {});
    } catch (err: unknown) {
      deps.logger?.warn({ err, telegramId: from.id }, 'Channel gate: the join prompt could not be sent');
    }
  };
}
