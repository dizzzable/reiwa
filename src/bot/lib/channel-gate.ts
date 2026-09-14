/**
 * Channel-subscription gate helpers — shared by the `/start` page and the
 * `check_channel` callback.
 *
 * The gate is configured on rezeis-admin (platform policy) and consumed by the
 * reiwa bot. A channel can be referenced three ways; this module resolves them
 * into a Telegram chat reference usable with `getChatMember`, derives a join
 * URL, asks Telegram about the user, and tracks "already passed" users for the
 * relaxed (non-re-check) mode.
 *
 * ── THE GATE THAT WAS OFF ─────────────────────────────────────────────────
 *
 * rezeis sends every policy key, and «ID канала» is `Settings.channelId BigInt?`,
 * so an operator who filled «Ссылка на канал» and left the ID empty sends
 * `channelId: null`. The resolver used to test `channelId !== undefined`, took
 * that `null` for a configured id, returned it, and the gate's "is it active"
 * check then reported it off: every user got the welcome screen, subscribed or
 * not, with nothing logged. `null` and blank now mean "not set", and each field
 * goes through one parser, so «Username канала» and «Ссылка на канал» are reached.
 */

import { GrammyError } from 'grammy';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { AdminClient } from '../../infrastructure/admin-client/index.js';
import { createErrorReporter } from '../../infrastructure/error-reporter/index.js';
import { sweepExpired } from './bounded-map.js';
import { isSubscribedMember, type ChatMemberLike } from './chat-membership.js';

export interface ChannelGatePolicy {
  readonly channelRequired?: boolean;
  readonly channelLink?: string | null;
  /** «ID канала». rezeis always sends the key: `null` when it is empty. */
  readonly channelId?: string | number | null;
  readonly channelUsername?: string | null;
  readonly channelRecheck?: boolean;
}

/** A public Telegram username, as `@name` and `t.me/name` carry it. */
const USERNAME_RE = /^[A-Za-z]\w{3,31}$/;
/** `t.me/<name>`, `t.me/s/<name>` (web preview), `telegram.me/<name>`; scheme optional. */
const PUBLIC_LINK_RE = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([^/?#]+)/i;

/**
 * One operator-typed channel reference → what `getChatMember` takes: "Unique
 * identifier for the target chat or username of the target supergroup or
 * channel (in the format `@channelusername`)".
 *
 * Takes a numeric id, `@name`, a bare `name` or a `t.me/name` link in any of
 * the three panel fields — operators paste a link into «Username канала» as
 * readily as into «Ссылка на канал». `null` for anything no Bot API call can
 * resolve: a private invite (`t.me/+…`, `t.me/joinchat/…`), a private post link
 * (`t.me/c/…`), or text that is not a channel reference.
 */
export function parseChannelReference(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^-?\d+$/.test(raw)) return raw;
  const name = raw.startsWith('@') ? raw.slice(1) : (PUBLIC_LINK_RE.exec(raw)?.[1] ?? raw);
  return USERNAME_RE.test(name) && name.toLowerCase() !== 'joinchat' ? `@${name}` : null;
}

/**
 * The chat `getChatMember` is asked about: «ID канала» first (it survives a
 * username change), then «Username канала», then «Ссылка на канал». `null` when
 * none of them names a chat the Bot API can resolve.
 */
export function resolveChannelChatId(policy: ChannelGatePolicy): string | null {
  return (
    parseChannelReference(policy.channelId) ??
    parseChannelReference(policy.channelUsername) ??
    parseChannelReference(policy.channelLink)
  );
}

/** Public URL that opens the channel for the "join" button. */
export function resolveChannelJoinUrl(policy: ChannelGatePolicy): string | null {
  const link = typeof policy.channelLink === 'string' ? policy.channelLink.trim() : '';
  // A link is kept as typed: a private invite joins even though it cannot be checked.
  if (/^(?:https?|tg):\/\//i.test(link)) return link;
  if (/^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(link)) return `https://${link}`;
  const name = parseChannelReference(link) ?? parseChannelReference(policy.channelUsername);
  return name?.startsWith('@') === true ? `https://t.me/${name.slice(1)}` : null;
}

/** What one membership check concluded. */
export type ChannelGateVerdict =
  /** «Канал обязателен» is off. */
  | 'off'
  | 'subscribed'
  /** Telegram says the user is not in the chat: show the join prompt. */
  | 'not-subscribed'
  /** The gate is on but this user could not be checked: let them in. */
  | 'unverified';

export interface ChatMemberApi {
  getChatMember(chatId: string, userId: number): Promise<ChatMemberLike>;
}

export interface ChannelGateDeps {
  readonly adminClient: AdminClient | null;
  readonly logger?: LoggerPort;
}

/**
 * Asks Telegram whether `userId` is in the gate's chat. Never throws.
 *
 * Never refuses a user it could not check either — a Telegram refusal must not
 * lock a paying subscriber out of the bot — but it no longer does that in
 * silence. Two causes are the operator's to fix and are reported (log + rezeis
 * Events page), once per hour per problem:
 *  - a policy naming no chat the Bot API can resolve (only an invite link);
 *  - Telegram refusing the call. `getChatMember` "is only guaranteed to work for
 *    other users if the bot is an administrator in the chat"; in a channel where
 *    it is not, every call answers 400 `member list is inaccessible`, so the
 *    gate let everybody in and nobody knew.
 * A network failure or a Telegram 5xx/429 passes by itself and is only logged.
 */
export async function checkChannelMembership(
  api: ChatMemberApi,
  policy: ChannelGatePolicy,
  userId: number,
  deps: ChannelGateDeps,
): Promise<ChannelGateVerdict> {
  if (policy.channelRequired !== true) return 'off';
  const chatId = resolveChannelChatId(policy);
  if (chatId === null) {
    const channelLink = policy.channelLink ?? '';
    alertOperator(deps, {
      key: `unresolvable:${channelLink}`,
      report: true,
      context: { channelLink },
      message:
        `Channel gate is on but checks nobody: «ID канала» is empty and neither «Username канала» ` +
        `nor «Ссылка на канал» ("${channelLink}") names a public channel. Everyone is let in until ` +
        `«ID канала» (-100…) or a public t.me/<name> link is set.`,
    });
    return 'unverified';
  }
  try {
    const member = await api.getChatMember(chatId, userId);
    return isSubscribedMember(member) ? 'subscribed' : 'not-subscribed';
  } catch (err: unknown) {
    if (err instanceof GrammyError && (err.error_code === 400 || err.error_code === 403)) {
      alertOperator(deps, {
        key: `refused:${chatId}:${err.description}`,
        report: true,
        context: { chatId, description: err.description },
        message:
          `Channel gate cannot check subscriptions in ${chatId}: Telegram answered "${err.description}". ` +
          `Everyone is let in until the bot is an administrator of that channel and «ID канала» / ` +
          `«Ссылка на канал» point at it.`,
      });
    } else {
      alertOperator(deps, {
        key: `unreachable:${chatId}`,
        report: false,
        context: { chatId, err },
        message: `Channel gate could not reach Telegram for ${chatId}; users are let in meanwhile.`,
      });
    }
    return 'unverified';
  }
}

/** How often one gate problem reaches the operator from this process. */
const ALERT_INTERVAL_MS = 60 * 60 * 1000;
const alertedAt = new Map<string, number>();

function alertOperator(
  deps: ChannelGateDeps,
  alert: {
    readonly key: string;
    /** Also to the rezeis Events page — only for what the operator must fix. */
    readonly report: boolean;
    readonly context: Record<string, unknown>;
    readonly message: string;
  },
): void {
  const now = Date.now();
  const last = alertedAt.get(alert.key);
  if (last !== undefined && now - last < ALERT_INTERVAL_MS) return;
  alertedAt.set(alert.key, now);
  sweepExpired(alertedAt, 100, (ts) => now - ts > ALERT_INTERVAL_MS);
  deps.logger?.warn(alert.context, alert.message);
  if (alert.report) {
    // A reporter per alert is fine: the throttle above is what keeps this rare.
    createErrorReporter({ adminClient: deps.adminClient, source: 'bot' }).report({
      message: alert.message,
      level: 'warning',
    });
  }
}

// ── Relaxed (non-re-check) mode: remember users who already passed ───────────
const PASS_TTL_MS = 24 * 60 * 60 * 1000;
const passedAt = new Map<number, number>();

/**
 * When the map is swept. Below this it is left alone, so the ordinary path is
 * one `Map.set`; a bot with more than this many gate passes live at once is
 * large enough that one O(size) walk per write is not worth noticing.
 */
const PASS_SWEEP_THRESHOLD = 5_000;

export function markChannelPassed(userId: number): void {
  passedAt.set(userId, Date.now());
  // Entries used to expire only when the SAME user was read again, so anybody
  // who passed the gate once and never came back left a row for the lifetime of
  // the process. The map grew with everyone who had ever touched the bot rather
  // than with who was using it — invisible because a deploy resets it.
  sweepExpired(passedAt, PASS_SWEEP_THRESHOLD, (ts) => Date.now() - ts > PASS_TTL_MS);
}

export function hasRecentlyPassedChannel(userId: number): boolean {
  const ts = passedAt.get(userId);
  if (ts === undefined) return false;
  if (Date.now() - ts > PASS_TTL_MS) {
    passedAt.delete(userId);
    return false;
  }
  return true;
}

/** Test hook — clears the passed-gate memory and the operator-alert throttle. */
export function resetChannelGateMemory(): void {
  passedAt.clear();
  alertedAt.clear();
}
