/**
 * The channel gate («Канал обязателен») — the one decision every surface asks:
 * the bot in front of every private-chat update (`middleware/channel-gate.ts`,
 * `/start`, «✅ Я подписался»), and the Mini App through the API
 * (`api/routes/channel-gate.ts`).
 *
 * The gate is configured on rezeis-admin (platform policy). A channel can be
 * referenced three ways; this module resolves them into the chat `getChatMember`
 * takes, derives a join URL, asks Telegram about the user, and remembers what it
 * learnt — so that standing in front of every update does not mean one Telegram
 * call per update.
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
 *
 * ── «ПЕРЕПРОВЕРЯТЬ ПОДПИСКУ» ──────────────────────────────────────────────
 *
 * The panel's hint is the contract.
 *  - ON (`channelRecheck !== false`) — "checked at every entry, and a user who
 *    unsubscribes later is blocked again". A pass is trusted for
 *    {@link STRICT_PASS_TTL_MS} by an ordinary update, in process memory only.
 *    A FRESH door ignores it and asks Telegram. ANY "not subscribed" Telegram
 *    gives under ON forgets the user's passes — in memory and in the store — so
 *    switching the setting to OFF cannot resurrect a pass of a user an ON check
 *    found outside the channel.
 *  - OFF — "checked only at the first entry". A pass goes to the shared store
 *    for {@link RELAXED_PASS_TTL_MS}, behind {@link RELAXED_PASS_MEMO_MS} of
 *    process memory, and EVERY door honours it, fresh ones included: a user who
 *    passed once is never asked again, even by «✅ Я подписался» or a quest's
 *    verify button, and a pass is never forgotten.
 * Every pass and memo is keyed by the RESOLVED chat id — a username lower-cased
 * (`channelGateChatKey`) — and the user id: pointing the gate at another channel
 * re-checks everyone; retyping «Username канала» in another case does not.
 *
 * ── THE DOORS ─────────────────────────────────────────────────────────────
 *
 * A FRESH check is one a user makes by saying something changed: «✅ Я
 * подписался», a quest's verify button, `/start`, the Mini App's re-check. It
 * skips the remembered "not subscribed" (and, under ON, the remembered pass) —
 * one who just joined must not be refused on a memo — asks Telegram at most once
 * per {@link FRESH_CHECK_WINDOW_MS} per user, and never joins a call an ordinary
 * update started: that call may have been issued before the user joined. Every
 * other update is an ordinary check.
 *
 * ── WHAT A TELEGRAM ANSWER COSTS ──────────────────────────────────────────
 *
 * The bot handles updates one at a time, on a token the API shares:
 *  - checks of one user share one call (a fresh one only a fresh one);
 *  - a "not subscribed" is remembered for {@link NOT_SUBSCRIBED_MEMO_MS};
 *  - a refusal ABOUT THE USER ({@link USER_REFUSAL_RE}; typically somebody the
 *    Bot API server cannot address, who opened the Mini App without starting the
 *    bot) lets that user in unverified for {@link USER_REFUSAL_MEMO_MS} — logged,
 *    never alerted: there is nothing for the operator to fix;
 *  - a refusal ABOUT THE CHAT ({@link CHAT_REFUSAL_RE}: the bot is not an
 *    administrator, the chat does not exist) lets everyone in that chat in
 *    unverified without asking, for {@link CHAT_REFUSAL_FIRST_BACKOFF_MS} — and
 *    for {@link CHAT_REFUSAL_REPEAT_BACKOFF_MS} when it repeats within
 *    {@link CHAT_REFUSAL_REPEAT_WINDOW_MS} — and reaches the operator at most
 *    once per {@link ALERT_INTERVAL_MS} per cause, across every process sharing
 *    the store;
 *  - a refusal nobody recognises is about the user for the first user it is
 *    seen for, and about the chat once the same words come back for a second
 *    user within {@link UNKNOWN_REFUSAL_WINDOW_MS}: a new wording must neither
 *    blame the operator for one user nor hide a broken gate for everyone;
 *  - 429 (or any answer naming `retry_after`) stops calls for that chat for
 *    `retry_after`, at most {@link FLOOD_BACKOFF_MAX_MS},
 *    {@link FLOOD_BACKOFF_DEFAULT_MS} when absent;
 *  - a network failure, a timeout, a 5xx: {@link UNREACHABLE_BACKOFF_MS};
 *  - every call races {@link TELEGRAM_DEADLINE_MS}, whatever client the caller
 *    passed, and a missed deadline is a network failure;
 *  - a back-off never shortens: an answer that asks for less keeps the longer.
 * A back-off or a refusal answers before the store is read — both let the user
 * in, so there is nothing a Redis round trip could change. Store writes and
 * operator alerts run in the background: a slow Redis never holds a decision.
 * A user the gate cannot check is always let in: a Telegram refusal must not
 * lock a paying subscriber out.
 */

import { GrammyError } from 'grammy';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { AdminClient } from '../../infrastructure/admin-client/index.js';
import {
  MemoryChannelGateStore,
  channelGateChatKey,
  type ChannelGateStore,
} from '../../infrastructure/channel-gate/channel-gate-store.js';
import { TtlMap } from '../../infrastructure/channel-gate/ttl-map.js';
import { createErrorReporter, type ErrorSource } from '../../infrastructure/error-reporter/index.js';
import { isSubscribedMember, type ChatMemberLike } from './chat-membership.js';

export type { ChannelGateStore } from '../../infrastructure/channel-gate/channel-gate-store.js';

export interface ChannelGatePolicy {
  readonly channelRequired?: boolean;
  readonly channelLink?: string | null;
  /** «ID канала». rezeis always sends the key: `null` when it is empty. */
  readonly channelId?: string | number | null;
  readonly channelUsername?: string | null;
  readonly channelRecheck?: boolean;
  /**
   * «Проверять только новых»: an ISO instant, or `null`/absent to ask
   * everyone. Set, only accounts created at or after it are asked; older
   * ones pass every door (`predatesNewUsersOnly`).
   */
  readonly channelNewUsersSince?: string | null;
}

/** A public Telegram username, as `@name` and `t.me/name` carry it. */
const USERNAME_RE = /^[A-Za-z]\w{3,31}$/;
/** `t.me/<name>`, `t.me/s/<name>` (web preview), `telegram.me/<name>`; scheme optional. */
const PUBLIC_LINK_RE = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([^/?#]+)/i;
/** `tg://resolve?domain=<name>` — the app link to a public username; `tg:resolve?…` works in Telegram too. */
const TG_RESOLVE_RE = /^tg:(?:\/\/)?resolve\?(?:[^#]*?&)?domain=([^&#]+)/i;
/** `tg://join?invite=<hash>` — the app link to a private invite; `tg:join?…` works in Telegram too. */
const TG_JOIN_RE = /^tg:(?:\/\/)?join\?(?:[^#]*?&)?invite=([\w-]+)/i;

/**
 * One operator-typed channel reference → what `getChatMember` takes: "Unique
 * identifier for the target chat or username of the target supergroup or
 * channel (in the format `@channelusername`)".
 *
 * Takes a numeric id, `@name`, a bare `name`, a `t.me/name` link or a
 * `tg://resolve?domain=name` link in any of the three panel fields — operators
 * paste a link into «Username канала» as readily as into «Ссылка на канал».
 * `null` for anything no Bot API call can resolve: a private invite (`t.me/+…`,
 * `t.me/joinchat/…`, `tg://join?…`), a private post link (`t.me/c/…`), or text
 * that is not a channel reference.
 */
export function parseChannelReference(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^-?\d+$/.test(raw)) return raw;
  const name = raw.startsWith('@')
    ? raw.slice(1)
    : (PUBLIC_LINK_RE.exec(raw)?.[1] ?? TG_RESOLVE_RE.exec(raw)?.[1] ?? raw);
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

/**
 * Whether two channel references name the same chat. Usernames compare without
 * case, as Telegram resolves them; an id and a username never compare equal,
 * because nothing here can tell that they name one channel.
 */
export function isSameChannelChat(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  const left = parseChannelReference(a);
  const right = parseChannelReference(b);
  return left !== null && right !== null && channelGateChatKey(left) === channelGateChatKey(right);
}

/**
 * Public URL that opens the channel for the "join" button.
 *
 * A web link is kept as typed: a private invite joins even though it cannot be
 * checked. An app link (`tg:`) is turned into its web twin, because inside the
 * Mini App's web view it does nothing; one without a web twin falls back to
 * «Username канала», as does a purely numeric «Ссылка на канал» — an id opens
 * nothing, and it used to stop that fallback from being reached.
 */
export function resolveChannelJoinUrl(policy: ChannelGatePolicy): string | null {
  const link = typeof policy.channelLink === 'string' ? policy.channelLink.trim() : '';
  if (/^https?:\/\//i.test(link)) return link;
  if (/^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(link)) return `https://${link}`;
  const invite = TG_JOIN_RE.exec(link)?.[1];
  if (invite !== undefined) return `https://t.me/+${invite}`;
  // `tg:resolve?domain=<name>` parses to `@name` like any public reference; any
  // other `tg:` link parses to nothing, and an id to a number — both of which
  // fall through to «Username канала».
  const fromLink = parseChannelReference(link);
  const name = fromLink?.startsWith('@') === true ? fromLink : parseChannelReference(policy.channelUsername);
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
  | 'unverified'
  /**
   * «Проверять только новых» is on and this account predates its moment:
   * let them in without asking Telegram. Every door already lets in
   * anything but `not-subscribed`, so this needs no handling of its own.
   */
  | 'exempt';

export interface ChatMemberApi {
  getChatMember(chatId: string, userId: number): Promise<ChatMemberLike>;
}

export interface ChannelGateDeps {
  readonly adminClient: AdminClient | null;
  readonly logger?: LoggerPort;
  /** Which surface reports a gate problem to rezeis. The bot unless said otherwise. */
  readonly source?: ErrorSource;
  /**
   * Where passes and the operator-alert throttle outlive this process: Redis
   * when `REDIS_URL` is set (`RedisChannelGateStore`). This process's memory
   * when omitted.
   */
  readonly store?: ChannelGateStore;
}

// ── Windows ─────────────────────────────────────────────────────────────────

/** How long an ordinary update trusts a pass while «Перепроверять подписку» is ON. */
export const STRICT_PASS_TTL_MS = 60 * 1000;
/** How long a pass lives in the shared store while «Перепроверять подписку» is OFF. */
export const RELAXED_PASS_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Process memory in front of the store while OFF, so a pass is not a Redis read per update. */
export const RELAXED_PASS_MEMO_MS = 10 * 60 * 1000;
/** How long an ordinary update answers a "not subscribed" without asking again. */
export const NOT_SUBSCRIBED_MEMO_MS = 10 * 1000;
/** How long a user Telegram refused to look up is let in without asking again. */
export const USER_REFUSAL_MEMO_MS = 60 * 1000;
/** How long a chat Telegram refused is not asked about, the first time. */
export const CHAT_REFUSAL_FIRST_BACKOFF_MS = 5 * 1000;
/** …and when the refusal repeats within {@link CHAT_REFUSAL_REPEAT_WINDOW_MS}. */
export const CHAT_REFUSAL_REPEAT_BACKOFF_MS = 60 * 1000;
export const CHAT_REFUSAL_REPEAT_WINDOW_MS = 2 * 60 * 1000;
/** An unrecognised refusal seen for a second user within this is about the chat. */
export const UNKNOWN_REFUSAL_WINDOW_MS = 10 * 60 * 1000;
/** Back-off after a 429 that names no `retry_after`. */
export const FLOOD_BACKOFF_DEFAULT_MS = 5 * 1000;
/** The longest `retry_after` honoured before asking again. */
export const FLOOD_BACKOFF_MAX_MS = 60 * 1000;
/** Back-off after a network failure, a timeout or a Telegram 5xx. */
export const UNREACHABLE_BACKOFF_MS = 5 * 1000;
/** How long one `getChatMember` may take, whatever client the caller passed. */
export const TELEGRAM_DEADLINE_MS = 6 * 1000;
/** Fresh checks of one user within this window share one Telegram answer. */
export const FRESH_CHECK_WINDOW_MS = 2 * 1000;
/** One operator alert per cause per this long, across every process sharing the store. */
export const ALERT_INTERVAL_MS = 60 * 60 * 1000;
/** One log line per condition per this long, per process. */
export const LOG_INTERVAL_MS = 10 * 60 * 1000;
/**
 * «Проверять только новых»: how long a dated account's answer is kept. The
 * answer cannot change for a given moment — the moment is part of the key —
 * so this only bounds how long a process holds it.
 */
export const ACCOUNT_AGE_MEMO_MS = 6 * 60 * 60 * 1000;
/** How long an account the panel could not date is asked as usual before the panel is asked again. */
export const ACCOUNT_AGE_UNKNOWN_MEMO_MS = 60 * 1000;
/** The panel's answer about an account's age is raced against this. */
export const ACCOUNT_AGE_DEADLINE_MS = 3 * 1000;

/**
 * Telegram's words for "this USER cannot be looked up here". TDLib answers
 * "Member not found" for somebody it cannot address, and the bot's own relay
 * already reads `PEER_ID_INVALID` as a refusal of one recipient.
 */
export const USER_REFUSAL_RE =
  /user not found|member not found|PARTICIPANT_ID_INVALID|USER_ID_INVALID|PEER_ID_INVALID|invalid user_id specified/i;

/** Telegram's words for "this CHAT cannot be checked by this bot": the operator's to fix. */
export const CHAT_REFUSAL_RE =
  /member list is inaccessible|chat not found|CHAT_ADMIN_REQUIRED|not enough rights|need administrator rights|bot is not a member|bot was kicked|CHANNEL_PRIVATE|CHANNEL_INVALID/i;

/** Most entries one per-user memory keeps; the oldest go first. */
const MAX_USER_ENTRIES = 100_000;

interface RunningCheck {
  readonly verdict: Promise<ChannelGateVerdict>;
  readonly fresh: boolean;
}

const memory = {
  strictPasses: new TtlMap<string>({ maxEntries: MAX_USER_ENTRIES }),
  relaxedPasses: new TtlMap<string>({ maxEntries: MAX_USER_ENTRIES }),
  notSubscribed: new TtlMap<string>({ maxEntries: MAX_USER_ENTRIES }),
  userRefusals: new TtlMap<string>({ maxEntries: MAX_USER_ENTRIES }),
  lastFresh: new TtlMap<string, ChannelGateVerdict>({ maxEntries: MAX_USER_ENTRIES }),
  /** Per chat: no call until the entry expires. */
  chatBackoff: new TtlMap<string, string>({ maxEntries: 1_000 }),
  /** Per chat: a chat refusal was seen within the repeat window. */
  chatRefusedRecently: new TtlMap<string>({ maxEntries: 1_000 }),
  /** Per chat + unrecognised description: the first user it was seen for. */
  unknownRefusals: new TtlMap<string, number>({ maxEntries: 1_000 }),
  /** Causes this process tried to claim an alert for, won or lost: a flood is not a store write per update. */
  alertAttempts: new TtlMap<string>({ maxEntries: 1_000 }),
  loggedAt: new TtlMap<string>({ maxEntries: 1_000 }),
  /** «Проверять только новых», per user + moment: whether the account predates it. */
  accountPredates: new TtlMap<string, boolean>({ maxEntries: MAX_USER_ENTRIES }),
  /** One panel lookup of an account's age per user at a time. */
  accountLookups: new Map<string, Promise<number | null>>(),
  running: new Map<string, RunningCheck>(),
  /** Store writes and alerts running in the background. */
  background: new Set<Promise<void>>(),
};

/** The store used when the caller passes none, and what a failing store is answered from. */
const processStore = new MemoryChannelGateStore();

// ── Asking Telegram ─────────────────────────────────────────────────────────

type TelegramAnswer =
  | { readonly kind: 'member'; readonly subscribed: boolean }
  | { readonly kind: 'refused'; readonly scope: 'user' | 'chat' | 'unknown'; readonly description: string }
  | { readonly kind: 'flood'; readonly retryAfterMs: number }
  | { readonly kind: 'unreachable'; readonly err: unknown };

class TelegramDeadlineError extends Error {
  public constructor() {
    super(`getChatMember did not answer within ${TELEGRAM_DEADLINE_MS} ms`);
    this.name = 'TelegramDeadlineError';
  }
}

/** One `getChatMember`, raced against the deadline. Never throws. */
async function askTelegram(api: ChatMemberApi, chatId: string, userId: number): Promise<TelegramAnswer> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const member = await Promise.race([
      Promise.resolve().then(() => api.getChatMember(chatId, userId)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TelegramDeadlineError()), TELEGRAM_DEADLINE_MS);
      }),
    ]);
    return { kind: 'member', subscribed: isSubscribedMember(member) };
  } catch (err: unknown) {
    return classifyTelegramFailure(err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Sorts a failed `getChatMember` into what the gate does about it. */
function classifyTelegramFailure(err: unknown): TelegramAnswer {
  if (err instanceof GrammyError) {
    const seconds = err.parameters.retry_after;
    if (err.error_code === 429 || typeof seconds === 'number') {
      const retryAfterMs =
        typeof seconds === 'number' && seconds > 0
          ? Math.min(seconds * 1000, FLOOD_BACKOFF_MAX_MS)
          : FLOOD_BACKOFF_DEFAULT_MS;
      return { kind: 'flood', retryAfterMs };
    }
    if (err.error_code === 400 || err.error_code === 403) {
      const description = typeof err.description === 'string' ? err.description : '';
      // The user's words first: reading a user's refusal as the chat's is what
      // lets everyone in and blames the operator for one person.
      const scope = USER_REFUSAL_RE.test(description) ? 'user' : CHAT_REFUSAL_RE.test(description) ? 'chat' : 'unknown';
      return { kind: 'refused', scope, description };
    }
  }
  return { kind: 'unreachable', err };
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * The gate's answer for one user. Every surface asks through here — the bot's
 * updates, `/start`, «Я подписался», the Mini App — so they agree. Never throws.
 */
export async function resolveChannelGateVerdict(
  api: ChatMemberApi,
  policy: ChannelGatePolicy,
  userId: number,
  deps: ChannelGateDeps,
  options: { readonly fresh?: boolean } = {},
): Promise<ChannelGateVerdict> {
  // The policy comes off the wire unvalidated (the admin transport casts the
  // body): anything but an object is no gate, never a throw.
  if (typeof policy !== 'object' || policy === null || policy.channelRequired !== true) return 'off';
  // Before every pass and memory below: an old account is not a member who
  // might have left — it is outside the gate altogether, so an unsubscribe
  // must not bring the prompt back to it.
  if (await predatesNewUsersOnly(policy, userId, deps)) return 'exempt';
  const chatId = resolveChannelChatId(policy);
  if (chatId === null) {
    inBackground(alertUnresolvable(deps, policy));
    return 'unverified';
  }
  const chatKey = channelGateChatKey(chatId);
  const key = `${chatKey}:${userId}`;
  const relaxed = policy.channelRecheck === false;
  const fresh = options.fresh === true;

  // A remembered pass: every door under OFF, only an ordinary update under ON.
  if (relaxed ? memory.relaxedPasses.has(key) : !fresh && memory.strictPasses.has(key)) return 'subscribed';
  if (fresh) {
    const recent = memory.lastFresh.get(key);
    if (recent !== undefined) return recent;
  } else if (memory.notSubscribed.has(key)) {
    return 'not-subscribed';
  }
  // Both let the user in: nothing a store read could change.
  if (memory.userRefusals.has(key) || memory.chatBackoff.has(chatKey)) return 'unverified';
  if (relaxed && (await storeCall(deps, 'hasPass', (store) => store.hasPass(chatKey, userId)))) {
    memory.relaxedPasses.set(key, true, RELAXED_PASS_MEMO_MS);
    return 'subscribed';
  }

  // A fresh door never takes the answer to a call an ordinary update started.
  const running = memory.running.get(key);
  let verdict: Promise<ChannelGateVerdict>;
  if (running !== undefined && (!fresh || running.fresh)) {
    verdict = running.verdict;
  } else {
    const check: RunningCheck = { verdict: decideWithTelegram(api, chatId, chatKey, userId, relaxed, deps), fresh };
    memory.running.set(key, check);
    void check.verdict.finally(() => {
      if (memory.running.get(key) === check) memory.running.delete(key);
    });
    verdict = check.verdict;
  }
  const answer = await verdict;
  if (fresh) memory.lastFresh.set(key, answer, FRESH_CHECK_WINDOW_MS);
  return answer;
}

// ── «Проверять только новых» ────────────────────────────────────────────────

/** An ISO instant as epoch milliseconds; `null` for anything that is not one. */
function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether this account was created before the moment «Проверять только
 * новых» names, and so passes as if the gate were off.
 *
 * ONLY EVER RELAXES THE GATE. Anything short of a dated account — the switch
 * off, an unreadable moment, no admin client, no account yet, a panel that
 * failed, took too long or predates the field — answers `false`, and the user
 * is asked exactly as before the switch existed. A new Telegram user has no
 * row until `/start` creates it, and is new by definition.
 *
 * «Account» means the panel's row, wherever it began: someone who registered
 * on the website long ago and opens the bot for the first time today is the
 * same customer, and is old (the owner's decision, 22.09.2026).
 */
async function predatesNewUsersOnly(
  policy: ChannelGatePolicy,
  userId: number,
  deps: ChannelGateDeps,
): Promise<boolean> {
  const since = parseInstant(policy.channelNewUsersSince);
  if (since === null) return false;
  const key = `${userId}:${since}`;
  const known = memory.accountPredates.get(key);
  if (known !== undefined) return known;
  const createdAt = await accountCreatedAt(userId, deps);
  if (createdAt === null) {
    // Kept briefly, so a panel outage or a user who never finishes /start is
    // not a panel request per update.
    memory.accountPredates.set(key, false, ACCOUNT_AGE_UNKNOWN_MEMO_MS);
    return false;
  }
  const predates = createdAt < since;
  memory.accountPredates.set(key, predates, ACCOUNT_AGE_MEMO_MS);
  return predates;
}

/** The account's creation, in epoch ms, or `null` when the panel cannot say. One lookup per user at a time. */
function accountCreatedAt(userId: number, deps: ChannelGateDeps): Promise<number | null> {
  const key = String(userId);
  const running = memory.accountLookups.get(key);
  if (running !== undefined) return running;
  const lookup = askPanelForAccountAge(userId, deps);
  memory.accountLookups.set(key, lookup);
  void lookup.finally(() => {
    if (memory.accountLookups.get(key) === lookup) memory.accountLookups.delete(key);
  });
  return lookup;
}

/** `internal/user/exists`, raced against a deadline. Never throws. */
async function askPanelForAccountAge(userId: number, deps: ChannelGateDeps): Promise<number | null> {
  const client = deps.adminClient;
  if (client === null) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      client.user.exists({ telegramId: String(userId) }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the panel did not date the account within ${ACCOUNT_AGE_DEADLINE_MS} ms`)),
          ACCOUNT_AGE_DEADLINE_MS,
        );
      }),
    ]);
    return answer.exists === true ? parseInstant(answer.createdAt) : null;
  } catch (err: unknown) {
    logAtMostEvery(deps, 'warn', 'account-age', { err },
      'Channel gate: the panel could not say how old an account is; «Проверять только новых» asks it as usual');
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Asks Telegram, remembers what the answer allows, reports what it must. Never throws. */
async function decideWithTelegram(
  api: ChatMemberApi,
  chatId: string,
  chatKey: string,
  userId: number,
  relaxed: boolean,
  deps: ChannelGateDeps,
): Promise<ChannelGateVerdict> {
  const key = `${chatKey}:${userId}`;
  const answer = await askTelegram(api, chatId, userId);
  switch (answer.kind) {
    case 'member':
      if (answer.subscribed) {
        memory.notSubscribed.delete(key);
        if (relaxed) {
          memory.relaxedPasses.set(key, true, RELAXED_PASS_MEMO_MS);
          inBackground(storeCall(deps, 'recordPass', (store) => store.recordPass(chatKey, userId, RELAXED_PASS_TTL_MS)));
        } else {
          memory.strictPasses.set(key, true, STRICT_PASS_TTL_MS);
        }
        return 'subscribed';
      }
      memory.notSubscribed.set(key, true, NOT_SUBSCRIBED_MEMO_MS);
      if (!relaxed) {
        memory.strictPasses.delete(key);
        memory.relaxedPasses.delete(key);
        inBackground(storeCall(deps, 'forgetPass', (store) => store.forgetPass(chatKey, userId)));
      }
      return 'not-subscribed';
    case 'refused':
      if (answer.scope === 'chat' || isSecondUserForUnknownRefusal(chatKey, userId, answer)) {
        backOffRefusedChat(deps, chatId, chatKey, answer.description);
      } else {
        memory.userRefusals.set(key, true, USER_REFUSAL_MEMO_MS);
        logAtMostEvery(deps, 'info', `user-refused:${chatKey}`, { chatId, userId, description: answer.description },
          `Channel gate: Telegram cannot look up user ${userId} in ${chatId} ("${answer.description}"); ` +
            'letting them in unverified. Usually somebody who opened the Mini App without ever starting the bot.');
      }
      return 'unverified';
    case 'flood':
      memory.chatBackoff.set(chatKey, answer.kind, answer.retryAfterMs);
      logAtMostEvery(deps, 'warn', `flood:${chatKey}`, { chatId, retryAfterMs: answer.retryAfterMs },
        `Channel gate: Telegram asked to slow down (429) for ${chatId}; users are let in unverified for ` +
          `${Math.ceil(answer.retryAfterMs / 1000)} s.`);
      return 'unverified';
    case 'unreachable':
      memory.chatBackoff.set(chatKey, answer.kind, UNREACHABLE_BACKOFF_MS);
      logAtMostEvery(deps, 'warn', `unreachable:${chatKey}`, { chatId, err: answer.err },
        `Channel gate could not reach Telegram for ${chatId}; users are let in meanwhile.`);
      return 'unverified';
  }
}

/**
 * An unrecognised refusal is about the user until the same words come back for
 * a DIFFERENT user within the window — then it is about the chat.
 */
function isSecondUserForUnknownRefusal(
  chatKey: string,
  userId: number,
  answer: { readonly scope: 'user' | 'chat' | 'unknown'; readonly description: string },
): boolean {
  if (answer.scope !== 'unknown') return false;
  const seenKey = `${chatKey}\u0000${answer.description}`;
  const firstUser = memory.unknownRefusals.get(seenKey);
  if (firstUser === undefined) {
    memory.unknownRefusals.set(seenKey, userId, UNKNOWN_REFUSAL_WINDOW_MS);
    return false;
  }
  return firstUser !== userId;
}

function backOffRefusedChat(deps: ChannelGateDeps, chatId: string, chatKey: string, description: string): void {
  const repeated = memory.chatRefusedRecently.has(chatKey);
  memory.chatRefusedRecently.set(chatKey, true, CHAT_REFUSAL_REPEAT_WINDOW_MS);
  memory.chatBackoff.set(chatKey, 'chat-refused', repeated ? CHAT_REFUSAL_REPEAT_BACKOFF_MS : CHAT_REFUSAL_FIRST_BACKOFF_MS);
  inBackground(
    alertOperator(deps, {
      cause: `refused:${chatKey}:${description}`,
      context: { chatId, description },
      message:
        `Channel gate cannot check subscriptions in ${chatId}: Telegram answered "${description}". ` +
        `Everyone is let in until the bot is an administrator of that channel and «ID канала» / ` +
        `«Ссылка на канал» point at it.`,
    }),
  );
}

// ── Reporting and the store ─────────────────────────────────────────────────

async function alertUnresolvable(deps: ChannelGateDeps, policy: ChannelGatePolicy): Promise<void> {
  const channelLink = policy.channelLink ?? '';
  await alertOperator(deps, {
    cause: `unresolvable:${channelLink}`,
    context: { channelLink },
    message:
      `Channel gate is on but checks nobody: «ID канала» is empty and neither «Username канала» ` +
      `nor «Ссылка на канал» ("${channelLink}") names a public channel. Everyone is let in until ` +
      `«ID канала» (-100…) or a public t.me/<name> link is set.`,
  });
}

/**
 * Warns and reports to the rezeis Events page — only when this process wins the
 * store's claim on the cause, so one misconfiguration is one alert an hour for
 * the bot and the API together. A lost claim is remembered as well as a won one.
 * Never throws.
 */
async function alertOperator(
  deps: ChannelGateDeps,
  alert: { readonly cause: string; readonly context: Record<string, unknown>; readonly message: string },
): Promise<void> {
  if (memory.alertAttempts.has(alert.cause)) return;
  memory.alertAttempts.set(alert.cause, true, ALERT_INTERVAL_MS);
  const claimed = await storeCall(deps, 'claimAlert', (store) => store.claimAlert(alert.cause, ALERT_INTERVAL_MS));
  if (!claimed) return;
  deps.logger?.warn(alert.context, alert.message);
  try {
    createErrorReporter({ adminClient: deps.adminClient, source: deps.source ?? 'bot' }).report({
      message: alert.message,
      level: 'warning',
    });
  } catch (err: unknown) {
    // `report` reaches into the admin client synchronously; a gate decision
    // must not fail because the report could not be filed.
    deps.logger?.warn({ err }, 'Channel gate: the operator alert could not be reported to rezeis');
  }
}

function logAtMostEvery(
  deps: ChannelGateDeps,
  level: 'info' | 'warn',
  key: string,
  context: Record<string, unknown>,
  message: string,
): void {
  if (memory.loggedAt.has(key)) return;
  memory.loggedAt.set(key, true, LOG_INTERVAL_MS);
  if (level === 'info') deps.logger?.info(context, message);
  else deps.logger?.warn(context, message);
}

/**
 * Runs one store operation. The contract says a store never rejects; one that
 * does is answered from this process's memory, and said so (throttled).
 */
async function storeCall<T>(
  deps: ChannelGateDeps,
  operation: string,
  run: (store: ChannelGateStore) => Promise<T>,
): Promise<T> {
  const store = deps.store ?? processStore;
  try {
    return await run(store);
  } catch (err: unknown) {
    logAtMostEvery(deps, 'warn', `store:${operation}`, { err, operation },
      `Channel gate: the shared store failed on ${operation}; answering from this process's memory`);
    return run(processStore);
  }
}

/** Runs work the decision does not wait for; it must not reject. */
function inBackground(work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  memory.background.add(settled);
  void settled.finally(() => memory.background.delete(settled));
}

/** Test hook — waits for every store write and alert still running in the background. */
export async function settleChannelGateBackground(): Promise<void> {
  while (memory.background.size > 0) await Promise.all([...memory.background]);
}

/** Test hook — a fresh process: every memory, back-off, throttle and the default store. */
export function resetChannelGateMemory(): void {
  memory.strictPasses.clear();
  memory.relaxedPasses.clear();
  memory.notSubscribed.clear();
  memory.userRefusals.clear();
  memory.lastFresh.clear();
  memory.chatBackoff.clear();
  memory.chatRefusedRecently.clear();
  memory.unknownRefusals.clear();
  memory.alertAttempts.clear();
  memory.loggedAt.clear();
  memory.accountPredates.clear();
  memory.accountLookups.clear();
  memory.running.clear();
  memory.background.clear();
  processStore.clear();
}
