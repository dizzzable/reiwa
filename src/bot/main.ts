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
import { resolve as resolvePath } from 'node:path';

import { loadConfig, resolveRezeisAdminUrl, resolveReiwaPublicUrl } from '../config.js';
import { AdminClient } from '../lib/admin-client.js';
import type { BotConfig } from '../infrastructure/bot-config/types.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../infrastructure/bot-config/cache.js';
import { RedisConfigPersistence } from '../infrastructure/bot-config/redis-config-persistence.js';
import type { ConfigPersistencePort } from '../application/ports/config-persistence.port.js';
import { BannerStore } from '../infrastructure/banner/index.js';
import { BOT_COMMANDS } from '../core/enums/command.enum.js';
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
import { applyBotSettings } from './lib/apply-bot-settings.js';
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
import { createLogger } from '../infrastructure/logger/index.js';
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
 * Durable last-known-good store for the bot config (Workstream 4). Built
 * once from `REDIS_URL` so a reboot before the first upstream fetch seeds
 * the cache from the last good config instead of the hardcoded default.
 * `undefined` when Redis isn't configured → cache stays in-memory only.
 */
let configPersistence: ConfigPersistencePort | undefined;

function getConfigPersistence(): ConfigPersistencePort | undefined {
  if (configPersistence !== undefined) return configPersistence;
  if (!config.REDIS_URL) return undefined;
  configPersistence = new RedisConfigPersistence(config.REDIS_URL);
  return configPersistence;
}

async function getBotConfig(adminClient: AdminClient | null): Promise<BotConfig> {
  if (botConfigCache !== null) return botConfigCache.get();
  if (!adminClient) return DEFAULT_BOT_CONFIG;
  // Lazy construction so an AdminClient set later (tests, hot-reload)
  // gets picked up. In the regular bootstrap path `startBot()` already
  // calls this through a primed cache.
  botConfigCache = new BotConfigCache({
    fetcher: () => adminClient.branding.getBotConfig(),
    hydrator: translator,
    fallback: DEFAULT_BOT_CONFIG,
    persistence: getConfigPersistence(),
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

  // Pre-warm the config cache
  const botConfig = await getBotConfig(adminClient);
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
      const translations = botConfig.translations ?? {};
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
  };
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
  // Dynamic screens last — its `screen:*` regex catches anything not
  // already grabbed by an earlier `bot.callbackQuery(<id>, ...)` so
  // operator-defined screens can shadow built-in callbacks just by
  // matching the same id.
  registerDynamicScreenPage(bot, pageDeps);

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
  // doesn't pay the upstream round-trip.

  const CONFIG_REFRESH_MS = 5 * 60 * 1000;
  const configRefreshTimer = setInterval(() => {
    getBotConfig(adminClient).catch((err: unknown) => {
      logger.warn({ err }, 'Background bot-config refresh failed');
    });
  }, CONFIG_REFRESH_MS);

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

  // Register Telegram slash-commands so the autocompletion bubble in
  // the chat input shows them immediately on /. We use the per-locale
  // form so the autocompletion descriptions follow the user's Telegram
  // language. Failures are non-fatal — the bot still works without
  // command suggestions.
  let commandSignature = await registerSlashCommands(bot, logger);

  // Push the operator’s Telegram profile (name / description / short
  // description). Fire-and-forget like the startup notices: it is up to six
  // Bot API round trips and none of them may hold up polling.
  void getBotConfig(adminClient)
    .then((cfg) =>
      applyBotSettings({
        bot,
        config: cfg,
        logger,
        translator,
        miniAppUrl: reiwaWebAppUrl,
      }),
    )
    .catch((err: unknown) => {
      logger.warn({ err }, 'bot/settings: startup apply failed');
    });

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

  // ── Cache invalidate + notify HTTP listener ───────────────────────────
  //
  // Single Node-native server bound to the docker network so rezeis-admin
  // can punch synchronous events at the bot. Auth: the same shared
  // secret used for outbound calls to admin (`REZEIS_INTERNAL_SHARED_SECRET`).
  // Three endpoints:
  //   - POST /invalidate         — force-refresh BotConfigCache (Wave 8)
  //   - POST /notify              — deliver a per-user message (Wave B)
  //   - POST /notify-broadcast    — deliver to a chat / topic (Wave B)
  const internalListener = startInternalHttpListener({
    bot: bot as unknown as Bot<Context>,
    cache: botConfigCache,
    secret: config.REZEIS_INTERNAL_SHARED_SECRET ?? null,
    port: config.BOT_INVALIDATE_PORT ?? 5100,
    devId: config.BOT_DEV_ID,
    logger,
    rezeisAdminUrl,
    keyboardUrls: { miniAppUrl: reiwaWebAppUrl, publicWebUrl: reiwaUrlButtonUrl },
    // A config push changes what the bot READS immediately; these two are the
    // things Telegram holds a copy of, so they have to be pushed on as well.
    // Both are no-ops when nothing they care about changed.
    onConfigApplied: async (fresh) => {
      commandSignature = await registerSlashCommands(bot, logger, commandSignature);
      await applyBotSettings({
        bot,
        config: fresh,
        logger,
        translator,
        miniAppUrl: reiwaWebAppUrl,
      });
    },
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
      clearInterval(configRefreshTimer);
      if (questRecheckTimer !== null) clearInterval(questRecheckTimer);
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
      }),
    closeServer:
      internalListener === null
        ? null
        : () => new Promise<void>((done) => internalListener.close(() => done())),
  });
}


/**
 * Register the canonical slash-command list with Telegram (RU + EN
 * scopes) so users see the autocomplete bubble on /. The `command`
 * value is fixed (Telegram routes by the literal string), but the
 * `description` is localised through the translator for whatever
 * locales the project supports today. New locales added to
 * `SUPPORTED_LOCALES` automatically get a new scope set without code
 * changes here.
 */
async function registerSlashCommands(
  bot: Bot<BotContext>,
  logger: ReturnType<typeof createLogger>,
  previousSignature?: string,
): Promise<string> {
  const { SUPPORTED_LOCALES } = await import('../core/enums/locale.enum.js');

  // Descriptions come from the translator, so an operator edit to a
  // `commands.*.description` row changes them. This function is called again
  // on every config invalidation for exactly that reason — but Telegram is
  // told only when the resolved text actually differs, because a bot-card save
  // that reordered a button has no business issuing three `setMyCommands`
  // calls.
  // The default scope is registered with the RU descriptions, so iterating the
  // supported locales covers every string this function can send.
  const signature = SUPPORTED_LOCALES.map((lang) =>
    BOT_COMMANDS.map(
      (command) => `${command}=${translator.t(`commands.${command}.description`, lang)}`,
    ).join('|'),
  ).join('||');
  if (previousSignature !== undefined && previousSignature === signature) {
    logger.info('Bot slash-commands unchanged — not re-registering');
    return signature;
  }

  // Default scope (catches users whose Telegram language isn't one of
  // the per-locale entries below — unlikely with ru/en covering most
  // CIS/global users, but still belt-and-braces).
  const defaultDescriptions = BOT_COMMANDS.map((command) => ({
    command,
    description: translator.t(`commands.${command}.description`, 'ru'),
  }));

  // Telegram's TLS endpoint is occasionally flaky during cold starts
  // (`ECONNRESET` mid-handshake). Retry the default scope once after a
  // small backoff so the catch-all still gets registered when the boot
  // happens to coincide with a TLS reset; per-locale scopes below
  // tolerate individual misses without leaving the bot command-less.
  const setDefaultWithRetry = async (): Promise<void> => {
    try {
      await bot.api.setMyCommands(defaultDescriptions);
      return;
    } catch (firstErr: unknown) {
      logger.warn(
        { err: firstErr },
        'setMyCommands (default scope) failed — retrying once',
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        await bot.api.setMyCommands(defaultDescriptions);
      } catch (retryErr: unknown) {
        logger.warn(
          { err: retryErr },
          'setMyCommands (default scope) retry failed — leaving per-locale scopes only',
        );
      }
    }
  };
  await setDefaultWithRetry();

  for (const lang of SUPPORTED_LOCALES) {
    const descriptions = BOT_COMMANDS.map((command) => ({
      command,
      description: translator.t(`commands.${command}.description`, lang),
    }));
    try {
      await bot.api.setMyCommands(descriptions, {
        language_code: lang,
      });
    } catch (err: unknown) {
      logger.warn({ err, lang }, 'setMyCommands (per-locale scope) failed');
    }
  }
  logger.info(
    { commandCount: BOT_COMMANDS.length, scopes: SUPPORTED_LOCALES.length + 1 },
    'Bot slash-commands registered',
  );
  return signature;
}

startBot().catch((err: unknown) => {
  // No logger yet (the failure happened during bootstrap before
  // createLogger ran); fall back to console.error so the operator sees
  // *something* instead of a silent crash.
  // eslint-disable-next-line no-console
  console.error('[reiwa-bot] startup failed:', err);
  process.exit(1);
});
