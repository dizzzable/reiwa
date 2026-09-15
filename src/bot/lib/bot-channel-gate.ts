/**
 * The bot's end of the channel gate: which Telegram client and which store every
 * bot surface asks through, and which chat the gate stands in.
 *
 * ── WHY THE GATE HAS ITS OWN CLIENT ───────────────────────────────────────
 *
 * `ctx.api` is the bot's grammY client, built in `main.ts` with nothing but the
 * API root, so it keeps grammY's default timeout of 500 seconds — sized for
 * long polling. `bot.start()` handles updates one at a time, so a single
 * `getChatMember` that Telegram stopped answering held EVERY user queued behind
 * it, a Stars `pre_checkout_query` (ten seconds to answer) among them, for up
 * to eight minutes. The gate asks through a client of its own with
 * {@link CHANNEL_GATE_API_TIMEOUT_SECONDS}; the gate module's own deadline sits
 * behind it for any client a caller passes.
 */
import { Api } from 'grammy';
import { Redis } from 'ioredis';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import { RedisChannelGateStore } from '../../infrastructure/channel-gate/redis-channel-gate-store.js';
import { TtlMap } from '../../infrastructure/channel-gate/ttl-map.js';
import { REDIS_CLIENT_OPTIONS } from '../../lib/redis-client-options.js';
import type { ChannelGateDeps, ChatMemberApi } from './channel-gate.js';
import type { BotChannelGate, BotContext, PageDeps } from '../pages/types.js';

/** The gate client's per-call timeout. Below the gate module's own 6 s deadline, so this one fires first. */
export const CHANNEL_GATE_API_TIMEOUT_SECONDS = 5;

/** How often the gate's own Redis client logs a connection error. */
const REDIS_ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000;

/** The dedicated client: the bot's token and API root, a short timeout. */
export function createChannelGateApi(
  token: string,
  apiRoot?: string | null,
  timeoutSeconds: number = CHANNEL_GATE_API_TIMEOUT_SECONDS,
): Api {
  return new Api(token, { ...(apiRoot ? { apiRoot } : {}), timeoutSeconds });
}

/**
 * Everything `main.ts` hands the pages for the gate: the dedicated client, and —
 * with `REDIS_URL` — a Redis store on a client of the gate's own. That client
 * starts connecting in the background as soon as it is built, and this function
 * owns it, so this is where its connection errors are logged, throttled. Without
 * `REDIS_URL` it says once that passes live in this process only.
 *
 * Why not on first use: the store sends nothing to a client that is not ready,
 * so a client left waiting for its first command stayed unconnected until the
 * store's first read asked it to connect. Every restart then answered the first
 * updates from process memory — a pass the Mini App could not see, an alert
 * the API could send again — and logged «Redis is wait» as if Redis were down.
 * A Redis that is down still does not stop the bot: the attempt fails in the
 * background, is logged by the listener below, and ioredis keeps retrying.
 */
export function createBotChannelGate(options: {
  readonly token: string;
  readonly apiRoot?: string | null;
  readonly redisUrl?: string | null;
  readonly logger: LoggerPort;
}): BotChannelGate {
  const api = createChannelGateApi(options.token, options.apiRoot);
  if (!options.redisUrl) {
    options.logger.warn(
      'Channel gate: REDIS_URL is not set — passes and the operator-alert throttle live in this process only, ' +
        'so a restart re-checks users «Перепроверять подписку» already let in, and the API alerts separately',
    );
    return { api };
  }
  const redis = new Redis(options.redisUrl, { ...REDIS_CLIENT_OPTIONS, lazyConnect: true });
  const loggedAt = new TtlMap<string>({ maxEntries: 10 });
  redis.on('error', (err: Error) => {
    if (loggedAt.has('error')) return;
    loggedAt.set('error', true, REDIS_ERROR_LOG_INTERVAL_MS);
    options.logger.warn({ err }, 'Channel gate: its Redis connection failed; the gate answers from process memory meanwhile');
  });
  // A failure is the `error` listener's to log; the promise only must not go unhandled.
  void redis.connect().catch(() => undefined);
  return { api, store: new RedisChannelGateStore({ redis, logger: options.logger }) };
}

/**
 * The client a bot surface asks the gate through. `ctx.api` only where no gate
 * client was wired (page specs); production always wires one.
 */
export function channelGateApiFor(ctx: BotContext, deps: Pick<PageDeps, 'channelGate'>): ChatMemberApi {
  return deps.channelGate?.api ?? ctx.api;
}

/** What the gate module needs from page dependencies. */
export function channelGateDepsOf(deps: Pick<PageDeps, 'adminClient' | 'logger' | 'channelGate'>): ChannelGateDeps {
  return {
    adminClient: deps.adminClient,
    logger: deps.logger,
    ...(deps.channelGate?.store !== undefined ? { store: deps.channelGate.store } : {}),
  };
}

/**
 * Whether this update comes from the user's own private chat with the bot — the
 * only chat the gate stands in, and the only one a screen carrying the user's
 * sign-in token may be sent to. A private chat's id is the other party's user id.
 */
export function isOwnPrivateChat(ctx: BotContext): boolean {
  const chat = ctx.chat;
  return chat?.type === 'private' && ctx.from !== undefined && chat.id === ctx.from.id;
}
