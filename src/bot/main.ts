/**
 * Reiwa Telegram Bot — Full-featured user-facing bot.
 *
 * Features adopted from STEALTHNET 4.0.0:
 * - Premium emoji (icon_custom_emoji_id on buttons, custom_emoji entities in text)
 * - Dynamic keyboard from admin panel config
 * - Multi-language support (i18n with backend translations)
 * - Profile, devices, VPN connection commands
 * - Language selection (/lang)
 * - Channel subscription enforcement
 * - Colored buttons (style: primary/success/danger)
 *
 * All data comes from rezeis-admin via internal API.
 */

import { Bot, Context, session, SessionFlavor } from 'grammy';
import type { Redis } from 'ioredis';
import { resolve as resolvePath } from 'node:path';
import { inspect } from 'node:util';

import { loadConfig, resolveRezeisAdminUrl, resolveReiwaPublicUrl } from '../config.js';
import { AdminClient } from '../lib/admin-client.js';
import { createBotChannelGate } from './lib/bot-channel-gate.js';
import type { BotConfig } from '../infrastructure/bot-config/types.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../infrastructure/bot-config/cache.js';
import { RedisConfigPersistence } from '../infrastructure/bot-config/redis-config-persistence.js';
import type { ConfigPersistencePort } from '../application/ports/config-persistence.port.js';
import type { LoggerPort } from '../application/ports/logger.port.js';
import { CONFIG_VERSION_KEYS } from '../infrastructure/config-versions/config-version.js';
import {
  NOOP_LAST_KNOWN_GOOD,
  RedisLastKnownGoodStore,
  createLastKnownGoodRedis,
  type LastKnownGoodStorePort,
} from '../infrastructure/config-versions/last-known-good.js';
import {
  NOOP_LATEST_CONFIG_VERSIONS,
  RedisLatestConfigVersions,
  memoiseLatest,
  type LatestConfigVersionsPort,
} from '../infrastructure/config-versions/latest.js';
import { ConfigVersionPoller, type VersionedGroup } from '../infrastructure/config-versions/poller.js';
import {
  configurePolicyCache,
  invalidatePolicyCache,
  peekPolicyCache,
} from '../infrastructure/admin-client/policy-cache.js';
import {
  configureLegalDocumentsCache,
  invalidateLegalDocumentsCache,
  peekLegalDocumentsCache,
} from '../infrastructure/admin-client/legal-documents-cache.js';
import { MESSAGE_CONFIG_BUDGET_MS } from './lib/config-within.js';
import { BannerStore } from '../infrastructure/banner/index.js';
import { isTelegramSafeButtonUrl } from './widgets/main-keyboard.js';
import { startInternalHttpListener } from './listeners/internal-http-listener.js';
import {
  registerDynamicScreenPage,
  registerClosePage,
  registerHelpCallbackPage,
  registerHelpCommandPage,
  registerInlineSharePage,
  registerInvitePage,
  registerLangPage,
  registerPaymentsPage,
  registerPaySupportPage,
  registerMenuPage,
  registerQuestChannelPage,
  registerRulesPage,
  registerStaleButtonPage,
  registerStartPage,
  registerAiSupportPage,
} from './pages/index.js';
import {
  notifyOperatorBotStarted,
  notifyDeveloperCredits,
  notifyOperatorBotStopped,
} from './lib/startup-notice.js';
import { createPollingController } from './lib/polling-controller.js';
import { installBotShutdownHandlers } from './lib/shutdown.js';
import {
  createTelegramSettingsSync,
  telegramSettingsOf,
  type TelegramSettingsSync,
} from './lib/telegram-settings-sync.js';
import { startConfigWarmup } from './lib/config-warmup.js';
import { runQuestChannelRecheck } from './lib/quest-channel-recheck.js';
import { printReiwaBanner } from '../core/banner.js';
import { createErrorReporter } from '../infrastructure/error-reporter/index.js';
import { installProcessErrorGuards } from '../infrastructure/error-reporter/process-guards.js';
import { createBotErrorHandler } from './lib/error-handler.js';
import {
  detectLocaleFromTelegram,
  translator,
  userLocaleCache,
} from '../infrastructure/i18n/index.js';
import { createLogger, redactBotTokens } from '../infrastructure/logger/index.js';
import { createChannelGateMiddleware } from './middleware/channel-gate.js';
import { createConfigFreshnessMiddleware } from './middleware/config-freshness.js';
import { createLocaleDetectMiddleware } from './middleware/locale-detect.js';
import { getMissingBotTokenError } from './startup-policy.js';

const productionBotTokenError = getMissingBotTokenError({
  nodeEnv: process.env.NODE_ENV,
  botToken: process.env.BOT_TOKEN,
});
if (productionBotTokenError) {
  // Keep this check before config parsing so an empty BOT_TOKEN gets the same
  // actionable message as an unset token instead of a generic schema error.
  // eslint-disable-next-line no-console
  console.error(`[reiwa-bot] startup failed: ${productionBotTokenError}`);
  process.exit(1);
}

const config = loadConfig();
const reiwaPublicUrl = resolveReiwaPublicUrl(config);

const reiwaWebAppUrl = isTelegramSafeButtonUrl(reiwaPublicUrl) ? reiwaPublicUrl : null;
const reiwaUrlButtonUrl = isTelegramSafeButtonUrl(reiwaPublicUrl) ? reiwaPublicUrl : null;

// ── Session ───────────────────────────────────────────────────────────────────

interface BotSession {
  step?: string;
}
type BotContext = Context & SessionFlavor<BotSession>;

// ── Bot config cache ──────────────────────────────────────────────────────────
//
// Wave 3 extracted the cache into `infrastructure/bot-config/cache.ts`.
// `botConfigCache` is constructed inside `startBot()` once we know
// whether an `AdminClient` is available; until then `getBotConfig()`
// closes over the singleton.

let botConfigCache: BotConfigCache | null = null;

/**
 * What Telegram holds of the operator's settings — the `/` commands, the bot's
 * name and descriptions, the menu button — kept in step with every config the
 * panel answers with (`lib/telegram-settings-sync.ts`). Built in `startBot()`
 * before the boot read, so that read's config is the first one offered.
 */
let settingsSync: TelegramSettingsSync | null = null;

/**
 * The bot's own client on reiwa's Redis, for the settings it keeps there: the
 * last-known-good copies and the key of latest versions. Built once from
 * `REDIS_URL`, lazily; `null` without Redis.
 */
let settingsRedis: Redis | null | undefined;

function getSettingsRedis(logger?: LoggerPort): Redis | null {
  if (settingsRedis !== undefined) return settingsRedis;
  settingsRedis = config.REDIS_URL ? createLastKnownGoodRedis(config.REDIS_URL, logger) : null;
  return settingsRedis;
}

/**
 * The last copy of each panel settings group the bot reads — its config, the
 * platform policy and the legal documents — in reiwa's Redis
 * (`infrastructure/config-versions/last-known-good.ts`). Without Redis the
 * copies stay in memory.
 */
let lastKnownGood: LastKnownGoodStorePort | null = null;

function getLastKnownGood(logger?: LoggerPort): LastKnownGoodStorePort {
  if (lastKnownGood !== null) return lastKnownGood;
  const redis = getSettingsRedis(logger);
  lastKnownGood = redis !== null ? new RedisLastKnownGoodStore({ redis, logger }) : NOOP_LAST_KNOWN_GOOD;
  return lastKnownGood;
}

/**
 * The newest version of each settings group anything in reiwa has heard of
 * (`infrastructure/config-versions/latest.ts`): the bot's poll writes it, and
 * every press compares the copy the bot holds with it. Without Redis nothing
 * is kept, and a press knows only what this process heard.
 */
let latestConfigVersions: LatestConfigVersionsPort | null = null;

function getLatestConfigVersions(logger?: LoggerPort): LatestConfigVersionsPort {
  if (latestConfigVersions !== null) return latestConfigVersions;
  const redis = getSettingsRedis(logger);
  latestConfigVersions =
    redis !== null ? new RedisLatestConfigVersions({ redis, logger }) : NOOP_LATEST_CONFIG_VERSIONS;
  return latestConfigVersions;
}

/**
 * Durable last-known-good store for the bot config (Workstream 4), so a reboot
 * before the first upstream fetch seeds the cache from the last good config
 * instead of the hardcoded default. `undefined` when Redis isn't configured →
 * cache stays in-memory only.
 */
let configPersistence: ConfigPersistencePort | undefined;

function getConfigPersistence(logger?: LoggerPort): ConfigPersistencePort | undefined {
  if (configPersistence !== undefined) return configPersistence;
  if (!config.REDIS_URL) return undefined;
  configPersistence = new RedisConfigPersistence(getLastKnownGood(logger));
  return configPersistence;
}

async function getBotConfig(adminClient: AdminClient | null, logger?: LoggerPort): Promise<BotConfig> {
  if (botConfigCache !== null) return botConfigCache.get();
  if (!adminClient) return DEFAULT_BOT_CONFIG;
  // Lazy construction so an AdminClient set later (tests, hot-reload)
  // gets picked up. In the regular bootstrap path `startBot()` already
  // calls this through a primed cache — the boot read, which passes the
  // logger: the cache writes one line per failed fetch, and built without
  // one, a panel outage left nothing in the log.
  botConfigCache = new BotConfigCache({
    fetcher: () => adminClient.branding.getBotConfig(),
    hydrator: translator,
    fallback: DEFAULT_BOT_CONFIG,
    persistence: getConfigPersistence(logger),
    logger,
    // The one read that may wait on the panel — nothing held, nothing saved —
    // waits no longer than a message's words do (`lib/config-within.ts`).
    firstLoadBudgetMs: MESSAGE_CONFIG_BUDGET_MS,
    // Every config the panel answered with — the warm-up's, any later read's —
    // so an operator's save whose own read failed still reaches Telegram at
    // the next answered read. Never a failed read's (see the option).
    onAnswered: (fresh) => void settingsSync?.offer(fresh),
  });
  return botConfigCache.get();
}

// ── Bot startup ───────────────────────────────────────────────────────────────

async function startBot(): Promise<void> {
  // Stamped before anything can fail, so the farewell notice reports how long
  // this process actually lived rather than how long it managed to serve.
  const startedAt = Date.now();
  const missingBotTokenError = getMissingBotTokenError({
    nodeEnv: process.env.NODE_ENV,
    botToken: config.BOT_TOKEN,
  });
  if (missingBotTokenError) {
    throw new Error(missingBotTokenError);
  }

  if (!config.BOT_TOKEN) {
    console.warn('[reiwa-bot] BOT_TOKEN not set — bot disabled');
    process.stdin.resume();
    return;
  }


  // Root logger for this process. Pages receive a child bound to the
  // page tag so log lines are easy to filter downstream.
  const logger = createLogger({
    service: 'bot',
  });

  const rezeisAdminUrl = resolveRezeisAdminUrl(config);
  const adminClient =
    rezeisAdminUrl && config.REZEIS_TOKEN
      ? new AdminClient(
          rezeisAdminUrl,
          config.REZEIS_TOKEN,
          config.REZEIS_INTERNAL_SHARED_SECRET ?? undefined,
        )
      : null;

  const errorReporter = createErrorReporter({ adminClient, source: 'bot' });

  // Last-resort guards for failures that escape grammy's bot.catch (stray
  // promise rejections, uncaught throws in timers/listeners).
  installProcessErrorGuards({ logger, errorReporter });

  // Before the first policy read (the channel gate, `/start`): a restart during
  // a panel outage then keeps the operator's access mode, channel gate and
  // rules gate, instead of opening them to everybody.
  configurePolicyCache({ lastKnownGood: getLastKnownGood(logger), logger });
  // Before the first rules screen: a restart during a panel outage still links
  // «Правила» to the operator's documents, not to the legacy rules link.
  configureLegalDocumentsCache({ lastKnownGood: getLastKnownGood(logger), logger });

  // Before the boot read, so the config it answers with is offered to it: the
  // pushes wait for `start` below, once the bot exists.
  const sync = createTelegramSettingsSync({ logger });
  settingsSync = sync;

  // Pre-warm the config cache — and build it, with the logger.
  const botConfig = await getBotConfig(adminClient, logger);
  logger.info(
    {
      emojiKeys: Object.keys(botConfig.botEmojis ?? {}).length,
      visibleButtons: botConfig.buttons.filter((b) => b.visible).length,
    },
    'Bot config loaded',
  );

  // ── Banner store ──────────────────────────────────────────────────────────
  //
  // 5-step lookup chain (see `BannerStorePort` for the contract). The
  // FS legs walk `assets/banners/<lang>/<name>.<ext>`. Operators can
  // override per-page or per-locale via the admin Bot-Texts UI by setting
  // `bot.banner.<name>[.<lang>]` rows; the store reads those through the
  // supplied `getOverride` callback that taps the bot-config translation
  // cache. The BotText `bot.banner_url` (managed by Wave 7 seed) maps to
  // the legacy `default` page name.
  const bannerStore = new BannerStore({
    assetsRoot: resolvePath(process.cwd(), 'assets/banners'),
    getOverride: (key: string): string | undefined => {
      // The config the bot holds NOW, not the boot read's: the boot read may
      // have been the saved copy or the defaults (a panel away at boot), and
      // an operator's banner saved since would never have reached this store
      // (W8 report D12).
      const translations = botConfigCache?.peek()?.translations ?? botConfig.translations ?? {};
      const value = translations[key];
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      // Reiwa's Wave 7 seed creates `bot.banner_url` as the canonical
      // key for the welcome banner. When the `default` page resolver
      // looks it up, route through that legacy key so admins editing
      // either field see the same image.
      if (key === 'bot.banner.default' && trimmed === '') {
        const legacy = translations['bot.banner_url']?.trim();
        return legacy && legacy.length > 0 ? legacy : undefined;
      }
      return trimmed.length > 0 ? trimmed : undefined;
    },
    logger,
  });

  const bot = new Bot<BotContext>(
    config.BOT_TOKEN,
    config.TELEGRAM_BOT_API_ROOT
      ? { client: { apiRoot: config.TELEGRAM_BOT_API_ROOT } }
      : undefined,
  );
  if (config.TELEGRAM_BOT_API_ROOT) {
    logger.info(
      { apiRoot: config.TELEGRAM_BOT_API_ROOT },
      'Using self-hosted Telegram Bot API server (2 GB upload limit)',
    );
  }
  bot.use(session({ initial: (): BotSession => ({}) }));

  // ── Locale auto-detect middleware ──────────────────────────────────────────
  bot.use(
    createLocaleDetectMiddleware({
      cache: userLocaleCache,
      detect: detectLocaleFromTelegram,
      adminClient,
    }),
  );

  // ── Settings as fresh as reiwa knows them, on every press ──────────────────
  //
  // Before any page — the channel gate's prompt included — an update that
  // renders something is answered from the newest settings reiwa has heard of:
  // the bot config, the platform policy the gate decides on, and the legal
  // documents before the rules screen. When the key of latest versions in Redis
  // (both processes' polls, the API's webhook) or the bot's own `/invalidate`
  // says a copy is behind, the panel is read once and waited for, within the
  // update's budget. Never asks the panel whether anything changed, never waits
  // past the budget, never throws (`middleware/config-freshness.ts`). One Redis
  // read serves a burst of presses.
  bot.use(
    createConfigFreshnessMiddleware({
      latest: memoiseLatest(() => getLatestConfigVersions(logger).read()),
      botConfig: () => botConfigCache,
      policy: peekPolicyCache,
      legalDocuments: peekLegalDocumentsCache,
      userLocale: { getSync: (id: number) => userLocaleCache.getSync(id) },
      peekConfig: () => botConfigCache?.peek() ?? null,
      logger,
    }),
  );

  // ── Channel gate: its own Telegram client and the shared store ─────────────
  //
  // The client: `ctx.api` keeps grammY's 500-second default timeout, and updates
  // are handled one at a time, so a `getChatMember` Telegram stopped answering
  // held every user queued behind it. The store: passes of «Перепроверять
  // подписку» OFF and the operator-alert throttle, shared with reiwa-api through
  // the same REDIS_URL. See `lib/bot-channel-gate.ts`.
  const channelGate = createBotChannelGate({
    token: config.BOT_TOKEN,
    apiRoot: config.TELEGRAM_BOT_API_ROOT,
    redisUrl: config.REDIS_URL,
    logger,
  });

  // All command + callback handlers live in bot/pages/. Composition
  // root just walks the registrar list.
  const pageDeps = {
    adminClient,
    translator,
    userLocale: {
      getSync: (id: number) => userLocaleCache.getSync(id),
      setSync: (id: number, lang: string) => userLocaleCache.setSync(id, lang),
      hasSync: (id: number) => userLocaleCache.hasSync(id),
    },
    getConfig: () => getBotConfig(adminClient),
    // What a reply that cannot wait for the panel renders with: the config the
    // bot holds, whatever its age (`lib/config-within.ts`).
    peekConfig: () => botConfigCache?.peek() ?? null,
    urls: {
      publicWebUrl: reiwaUrlButtonUrl,
      miniAppUrl: reiwaWebAppUrl,
      rezeisAdminUrl,
    },
    bannerStore,
    envSupportUsername: config.BOT_SUPPORT_USERNAME ?? undefined,
    rememberBannerFileId: (bannerUrl: string, fileId: string): void => {
      botConfigCache?.stampBannerFileId(bannerUrl, fileId);
    },
    rememberScreenBannerFileId: (shortId: string, mediaUrl: string, fileId: string): void => {
      botConfigCache?.stampScreenBannerFileId(shortId, mediaUrl, fileId);
    },
    logger,
    channelGate,
  };

  // ── Channel gate («Канал обязателен») ──────────────────────────────────────
  //
  // After session + locale (the join prompt renders in the user's language) and
  // before EVERY page below: a non-subscriber's message or button press in their
  // own chat stops here with the join prompt. `/start`, «Я подписался»,
  // `/paysupport`, the language picker, the ways out of AI support and `close`
  // pass; so do service messages and anything outside the user's own chat. See
  // `middleware/channel-gate.ts`.
  bot.use(createChannelGateMiddleware(pageDeps));

  registerLangPage(bot, pageDeps);
  registerInvitePage(bot, pageDeps);
  // Inline mode. Registered like any other page, but it is the only handler
  // here that answers an update with no chat behind it — see the header of
  // `pages/inline-share.ts`. Needs no `allowed_updates` change: none is set,
  // and Telegram delivers `inline_query` under the default set. It DOES need
  // `/setinline` in @BotFather, which no API method can do for us.
  registerInlineSharePage(bot, pageDeps);
  registerRulesPage(bot, pageDeps);
  registerHelpCallbackPage(bot, pageDeps);
  registerHelpCommandPage(bot, pageDeps);
  registerPaySupportPage(bot, pageDeps);
  // Telegram Stars. Registered BEFORE the AI-support catch-all: a
  // `successful_payment` message carries no text so `bot.hears` would not
  // match it anyway, but the ordering is the guarantee rather than the
  // accident of another page’s filter.
  registerPaymentsPage(bot, pageDeps);
  registerMenuPage(bot, pageDeps);
  registerStartPage(bot, pageDeps);
  registerQuestChannelPage(bot, pageDeps);
  registerClosePage(bot, pageDeps);
  // AI support — /support command enters AI chat mode
  registerAiSupportPage(bot, pageDeps);
  // Dynamic screens next to last. Besides `screen:<shortId>` this page answers a
  // callback whose whole data is a screen's bare shortId, and that handler must
  // see only data no page above has claimed: a screen whose shortId is spelled
  // like `help` must not take `help` over.
  registerDynamicScreenPage(bot, pageDeps);
  // A button nothing above knows — an old message's, onto a button the operator
  // removed or changed: «Меню обновилось» and the current main menu in place of
  // that message (`pages/stale-button.ts`). The very last handler, and no
  // handler after it: it takes whatever data reaches it. The order is pinned by
  // `test/bot/callback-routing.test.ts`.
  registerStaleButtonPage(bot, pageDeps);

  // ── Error handler ──────────────────────────────────────────────────────────

  bot.catch(
    createBotErrorHandler({
      logger,
      errorReporter,
      translator,
      userLocale: pageDeps.userLocale,
      getConfig: pageDeps.getConfig,
      envSupportUsername: pageDeps.envSupportUsername,
    }),
  );

  // ── Config refresh timer ───────────────────────────────────────────────────
  //
  // The cache auto-refreshes on next `get()` after `ttlMs`, but a
  // periodic warm-fetch keeps the cache hot so the next user request
  // doesn't pay the upstream round-trip — a forced read on every tick, before
  // the TTL is out (`lib/config-warmup.ts`). No cache, no panel: nothing to warm.
  // A failed tick is logged by the cache, as every failed fetch is.

  const configRefreshTimer = botConfigCache !== null ? startConfigWarmup(botConfigCache) : null;

  // ── Channel-quest membership recheck timer ─────────────────────────────────
  //
  // rezeis owns quest state but has no Telegram token, so the bot periodically
  // re-verifies unclaimed SUBSCRIBE_CHANNEL completions with its own
  // getChatMember and reports the result. A user who left the channel loses
  // claimability until they re-subscribe. Skipped entirely in degraded mode
  // (no adminClient). Best-effort: failures are logged, never fatal.
  let questRecheckTimer: NodeJS.Timeout | null = null;
  if (adminClient !== null) {
    const CHANNEL_RECHECK_MS = 10 * 60 * 1000;
    questRecheckTimer = setInterval(() => {
      void runQuestChannelRecheck({ adminClient, api: bot.api, logger }).catch((err: unknown) => {
        logger.warn({ err }, 'Quest channel recheck tick failed');
      });
    }, CHANNEL_RECHECK_MS);
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  // What Telegram holds of the operator's settings: the `/` commands (the
  // autocomplete bubble, per language), the bot's name and descriptions, the
  // menu button. The boot read's config goes out now — only if the panel
  // answered it: a boot on the saved copy or on the defaults pushes nothing,
  // and the first answered read (the warm-up's at the latest) does instead. A
  // save's config follows from `onConfigApplied` below, and any later answered
  // read pushes what differs (`lib/telegram-settings-sync.ts`). Fire-and-forget
  // like the startup notices: up to nine Bot API round trips, none of which may
  // hold up polling. Failures are non-fatal — the bot works without them.
  //
  // No panel at all (no AdminClient): the defaults ARE this bot's config, and
  // without them it would have no command list.
  if (botConfigCache === null) void sync.offer(botConfig, { force: true });
  void sync.start(telegramSettingsOf({ bot, translator, logger, miniAppUrl: reiwaWebAppUrl }));

  // Operator startup notice (snoups-style): ping BOT_DEV_ID with the current
  // access mode + a Close button. Best-effort, never blocks startup.
  void notifyOperatorBotStarted({
    bot,
    devId: config.BOT_DEV_ID,
    adminClient,
    translator,
    logger,
    // Card labels are operator-editable i18n keys, so they may carry `:slug:` /
    // `{{KEY}}` emoji tokens that have to be resolved before Telegram sees them.
    getConfig: pageDeps.getConfig,
  });

  // Developer-only credits card (open-core attribution + project links).
  void notifyDeveloperCredits({
    bot,
    devId: config.BOT_DEV_ID,
    translator,
    logger,
    getConfig: pageDeps.getConfig,
  });

  // Polling lifecycle with self-healing on 409 / network blips.
  //
  // Telegram allows only ONE long-poll consumer per token. When a
  // previous reiwa-bot instance crashes mid-getUpdates, Telegram keeps
  // the stale polling slot alive for ~30 seconds, so the freshly
  // restarted instance hits `409 Conflict` and grammy's `bot.start()`
  // promise rejects. Without a retry, Docker's `restart: unless-stopped`
  // tail-spins the container into a crash loop because every restart
  // races the dying ghost session.
  //
  // We solve this in-process: wrap `bot.start()` in an exponential
  // backoff loop and log every retry so operators can see when we're
  // waiting for a stale session to clear.
  //
  // The loop is held rather than fired and forgotten, because shutdown
  // needs both halves of it: something to tell the retry loop to stop, and
  // something to WAIT for while the last handler finishes. See
  // `createPollingController`.
  const polling = createPollingController(bot, logger, () => printReiwaBanner('bot'));
  void polling.run();

  // ── Config version poll ────────────────────────────────────────────────────
  //
  // The safety net under `/invalidate` and `/invalidate-policy`: every ~20 s the
  // bot asks the panel which version of each settings group is current and
  // re-reads the groups it holds an older copy of — a lost hint, a panel boot
  // with new defaults, a backup restore (`infrastructure/config-versions/poller.ts`).
  // The re-read of the bot config goes the way a save does: its answer is
  // pushed on to what Telegram holds (`sync.offer(…, { force: true })`).
  const configGroups: readonly VersionedGroup[] = [
    {
      key: CONFIG_VERSION_KEYS.botConfig,
      held: () => botConfigCache?.heldVersion() ?? null,
      // `forceInvalidate` below is the reset and the read in one.
      reset: () => undefined,
      reload: async () => {
        const fresh = (await botConfigCache?.forceInvalidate('config-version-poll')) ?? null;
        if (fresh !== null) await sync.offer(fresh, { force: true });
      },
    },
    {
      key: CONFIG_VERSION_KEYS.platformPolicy,
      held: () => peekPolicyCache()?.heldVersion() ?? null,
      reset: invalidatePolicyCache,
      reload: () => peekPolicyCache()?.get(),
    },
    {
      key: CONFIG_VERSION_KEYS.legalDocumentsRu,
      held: () => peekLegalDocumentsCache()?.heldVersion('ru') ?? null,
      reset: invalidateLegalDocumentsCache,
      reload: () => peekLegalDocumentsCache()?.refreshHeld(),
    },
    {
      key: CONFIG_VERSION_KEYS.legalDocumentsEn,
      held: () => peekLegalDocumentsCache()?.heldVersion('en') ?? null,
      reset: invalidateLegalDocumentsCache,
      reload: () => peekLegalDocumentsCache()?.refreshHeld(),
    },
  ];
  const configVersionPoller =
    adminClient !== null
      ? new ConfigVersionPoller({
          consumer: 'bot',
          groups: configGroups,
          poll: (report) => adminClient.system.pollConfigVersions(report),
          // What the panel said goes into reiwa's key of latest versions too,
          // which every press compares with (the API's poll writes it as well).
          onVersions: (versions, answeredAt) => void getLatestConfigVersions(logger).recordPoll(versions, answeredAt),
          logger,
        })
      : null;
  configVersionPoller?.start();

  // ── Cache invalidate + notify HTTP listener ───────────────────────────
  //
  // Single Node-native server on the compose network, never published. Its
  // one caller is reiwa-api, which relays the panel's signed webhooks here
  // (`api/routes/webhooks.ts`); the panel never dials the bot. Auth: an HMAC
  // keyed with the same shared secret used for outbound calls to admin
  // (`REZEIS_INTERNAL_SHARED_SECRET`).
  // Endpoints (the full list lives in `internal-http-listener.ts`):
  //   - POST /invalidate                 — force-refresh BotConfigCache
  //   - POST /invalidate-policy          — drop the bot's policy + legal-documents caches
  //   - POST /notify                     — deliver a per-user message
  //   - POST /notify-dev(-document)      — operator dev-fallback card / report
  //   - POST /notify-broadcast(-document) — deliver to a chat / topic
  //   - POST /notify-backup-document     — upload a backup file
  const internalListener = startInternalHttpListener({
    bot: bot as unknown as Bot<Context>,
    cache: botConfigCache,
    secret: config.REZEIS_INTERNAL_SHARED_SECRET ?? null,
    port: config.BOT_INVALIDATE_PORT ?? 5100,
    devId: config.BOT_DEV_ID,
    logger,
    rezeisAdminUrl,
    keyboardUrls: { miniAppUrl: reiwaWebAppUrl, publicWebUrl: reiwaUrlButtonUrl },
    // A config push changes what the bot READS immediately; the commands, the
    // profile and the menu button are what Telegram holds a copy of, so they
    // have to be pushed on as well. A save re-reads the profile and the menu
    // button from Telegram (`force`); the commands go when their text changed.
    // A save whose read failed never gets here — the next answered read
    // pushes it (the cache's `onAnswered`).
    onConfigApplied: (fresh) => sync.offer(fresh, { force: true }),
    onUserBlocked: async (telegramId: string) => {
      if (adminClient === null) return;
      try {
        await adminClient.user.markBotBlocked(telegramId);
      } catch (err: unknown) {
        logger.warn({ err, telegramId }, 'Notify: failed to mark user as bot-blocked');
      }
    },
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  //
  // Registered LAST, once every handle it has to release exists. Until this
  // was here the process had no signal handler at all, so `docker stop` killed
  // it mid-`getUpdates` — which is precisely the "previous instance crashed"
  // case the polling loop below apologises for. Every restart was one. See
  // `lib/shutdown.ts` for the ordering and the budgets it runs against.
  installBotShutdownHandlers({
    startedAt,
    logger,
    clearTimers: () => {
      if (configRefreshTimer !== null) clearInterval(configRefreshTimer);
      if (questRecheckTimer !== null) clearInterval(questRecheckTimer);
      configVersionPoller?.stop();
    },
    // Releases the slot AND waits for the handler still running behind it.
    // `bot.stop()` alone acknowledges the in-flight update to Telegram and
    // returns, so exiting on its heels destroys work Telegram will never send
    // again — a debited Stars payment among it. See `createPollingController`.
    stopPolling: () => polling.stop(),
    farewell: (signal, uptimeMs) =>
      notifyOperatorBotStopped({
        bot,
        devId: config.BOT_DEV_ID,
        translator,
        logger,
        signal,
        uptimeMs,
        getConfig: pageDeps.getConfig,
      }),
    closeServer:
      internalListener === null
        ? null
        : () => new Promise<void>((done) => internalListener.close(() => done())),
  });
}


startBot().catch((err: unknown) => {
  // No logger yet (the failure happened during bootstrap before
  // createLogger ran); fall back to console.error so the operator sees
  // *something* instead of a silent crash.
  // Printed as redacted text, never the error object: a startup that fails on
  // the Bot API (`getMe`, `setMyCommands`) throws grammY's `HttpError`, whose
  // wrapped node-fetch error quotes the request URL with the token in it.
  // eslint-disable-next-line no-console
  console.error('[reiwa-bot] startup failed:', redactBotTokens(inspect(err)));
  process.exit(1);
});
