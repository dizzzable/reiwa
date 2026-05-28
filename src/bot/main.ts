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
import * as http from 'node:http';
import { resolve as resolvePath } from 'node:path';

import { loadConfig, resolveRezeisAdminUrl, resolveReiwaPublicUrl } from '../config.js';
import { AdminClient } from '../lib/admin-client.js';
import type { BotConfig } from '../infrastructure/bot-config/types.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../infrastructure/bot-config/cache.js';
import { BannerStore } from '../infrastructure/banner/index.js';
import { BOT_COMMANDS } from '../core/enums/command.enum.js';
import { isTelegramSafeButtonUrl } from './widgets/main-keyboard.js';
import {
  registerActivityPage,
  registerBuyPage,
  registerDynamicScreenPage,
  registerHelpCallbackPage,
  registerHelpCommandPage,
  registerInvitePage,
  registerLangPage,
  registerMenuPage,
  registerPlansPage,
  registerProfilePage,
  registerPromoPage,
  registerReferralPage,
  registerRulesPage,
  registerStartPage,
  registerSubscriptionPage,
} from './pages/index.js';
import {
  detectLocaleFromTelegram,
  translator,
  userLocaleCache,
} from '../infrastructure/i18n/index.js';
import { createLogger } from '../infrastructure/logger/index.js';
import { createLocaleDetectMiddleware } from './middleware/locale-detect.js';

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
  });
  return botConfigCache.get();
}

// ── Bot startup ───────────────────────────────────────────────────────────────

async function startBot(): Promise<void> {
  if (!config.BOT_TOKEN) {
    console.warn('[reiwa-bot] BOT_TOKEN not set — bot disabled');
    process.stdin.resume();
    return;
  }

  // Root logger for this process. Pages receive a child bound to the
  // page tag so log lines are easy to filter downstream.
  const logger = createLogger({
    service: 'bot',
    pretty: config.NODE_ENV !== 'production',
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

  const bot = new Bot<BotContext>(config.BOT_TOKEN);
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
    urls: { publicWebUrl: reiwaUrlButtonUrl, miniAppUrl: reiwaWebAppUrl },
    bannerStore,
    envSupportUsername: config.BOT_SUPPORT_USERNAME ?? undefined,
    logger,
  };
  registerLangPage(bot, pageDeps);
  registerInvitePage(bot, pageDeps);
  registerRulesPage(bot, pageDeps);
  registerHelpCallbackPage(bot, pageDeps);
  registerHelpCommandPage(bot, pageDeps);
  registerPlansPage(bot, pageDeps);
  registerSubscriptionPage(bot, pageDeps);
  registerPromoPage(bot, pageDeps);
  registerProfilePage(bot, pageDeps);
  registerReferralPage(bot, pageDeps);
  registerActivityPage(bot, pageDeps);
  registerBuyPage(bot, pageDeps);
  registerMenuPage(bot, pageDeps);
  registerStartPage(bot, pageDeps);
  // Dynamic screens last — its `screen:*` regex catches anything not
  // already grabbed by an earlier `bot.callbackQuery(<id>, ...)` so
  // operator-defined screens can shadow built-in callbacks just by
  // matching the same id.
  registerDynamicScreenPage(bot, pageDeps);

  // ── Error handler ──────────────────────────────────────────────────────────

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: { update: err.message } }, 'Bot handler error');
  });

  // ── Config refresh timer ───────────────────────────────────────────────────
  //
  // The cache auto-refreshes on next `get()` after `ttlMs`, but a
  // periodic warm-fetch keeps the cache hot so the next user request
  // doesn't pay the upstream round-trip.

  const CONFIG_REFRESH_MS = 5 * 60 * 1000;
  setInterval(() => {
    getBotConfig(adminClient).catch((err: unknown) => {
      logger.warn({ err }, 'Background bot-config refresh failed');
    });
  }, CONFIG_REFRESH_MS);

  // ── Start ──────────────────────────────────────────────────────────────────

  // Register Telegram slash-commands so the autocompletion bubble in
  // the chat input shows them immediately on /. We use the per-locale
  // form so the autocompletion descriptions follow the user's Telegram
  // language. Failures are non-fatal — the bot still works without
  // command suggestions.
  await registerSlashCommands(bot, logger);

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
  // waiting for a stale session to clear. `dropPendingUpdates` on the
  // first attempt lets us reset the offset cleanly on cold start; the
  // retry attempts keep it false so we don't lose any updates that
  // arrived after the previous crash.
  void runPollingLoop(bot, logger);

  // ── Cache invalidate HTTP listener ──────────────────────────────────────
  //
  // Tiny built-in HTTP server (Node native, no Express) bound to the
  // docker network so rezeis-admin can punch a synchronous cache-bust
  // when an operator saves the bot config. Without this the bot would
  // wait up to 5 minutes (the BotConfigCache TTL) before picking up
  // the change.
  //
  // Auth: the same shared secret reiwa uses to sign outbound calls to
  // admin (`REZEIS_INTERNAL_SHARED_SECRET`) is used here as a bearer
  // token. No HMAC because the request body is empty and the path is
  // tightly scoped.
  startInvalidateServer({
    cache: botConfigCache,
    secret: config.REZEIS_INTERNAL_SHARED_SECRET ?? null,
    port: config.BOT_INVALIDATE_PORT ?? 5100,
    logger,
  });
}

async function runPollingLoop(
  bot: Bot<BotContext>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  let attempt = 0;
  // Maximum interval between retries (5 minutes). Telegram's stale
  // polling slots clear in ~30s; anything longer is paranoia.
  const MAX_BACKOFF_MS = 5 * 60 * 1000;

  while (true) {
    try {
      await bot.start({
        drop_pending_updates: attempt === 0,
        // Short timeout means we cycle through getUpdates more often,
        // which gives us more chances to win the polling slot when a
        // rogue / staging deployment is competing for the same token.
        // 5 seconds is the sweet spot: long enough that Telegram's
        // long-poll mechanism still saves us most of the round-trips,
        // short enough that we'll grab the slot within ~5s of a rival
        // releasing it. Default would be 30s.
        timeout: 5,
        onStart: (info) =>
          logger.info(
            { username: info.username, attempt },
            attempt === 0 ? 'reiwa-bot started' : 'reiwa-bot resumed polling',
          ),
      });
      // bot.start() returns when the polling loop terminates cleanly
      // (e.g. .stop() called). Treat that as a graceful shutdown rather
      // than reconnect-on-success.
      logger.info('reiwa-bot polling loop exited cleanly');
      return;
    } catch (err: unknown) {
      attempt += 1;
      // Aggressive race-back-in strategy: the first 5 attempts use a
      // short fixed delay (200ms) so we re-enter Telegram's polling
      // queue almost immediately after losing the slot. After that we
      // fall back to exponential backoff up to 5 minutes — this only
      // kicks in if the rogue poller is permanently winning, in which
      // case spamming Telegram won't help us.
      const isFastRetry = attempt <= 5;
      const backoffMs = isFastRetry
        ? 200
        : Math.min(2_000 * 2 ** Math.min(attempt - 6, 7), MAX_BACKOFF_MS);
      logger.warn(
        { err, attempt, backoffMs },
        'bot.start() failed — retrying after backoff',
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
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
): Promise<void> {
  const { SUPPORTED_LOCALES } = await import('../core/enums/locale.enum.js');

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
}

/**
 * Tiny HTTP server for synchronous cache-bust from rezeis-admin.
 *
 * Endpoint:
 *   POST /invalidate
 *     - header `X-Auth-Token: <REZEIS_INTERNAL_SHARED_SECRET>`
 *     - 204 on success, 401 on missing/wrong token, 503 if the cache
 *       hasn't been initialised yet (cold start race window)
 *
 * The server is bound to `0.0.0.0` inside the docker network. There
 * is no HTTPS termination here — that's the docker network boundary
 * and the operator's responsibility (only services on
 * `remnawave-network` can reach it). External traffic NEVER hits
 * this port because docker-compose doesn't publish it.
 *
 * If `REZEIS_INTERNAL_SHARED_SECRET` is unset (dev / smoke tests) we
 * skip the listener entirely — no auth means no endpoint, period.
 */
function startInvalidateServer(opts: {
  cache: BotConfigCache | null;
  secret: string | null;
  port: number;
  logger: ReturnType<typeof createLogger>;
}): void {
  const { cache, secret, port, logger } = opts;
  if (secret === null || secret.length === 0) {
    logger.info(
      'Cache-invalidate endpoint disabled (REZEIS_INTERNAL_SHARED_SECRET unset)',
    );
    return;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/invalidate') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const token = req.headers['x-auth-token'];
    if (typeof token !== 'string' || token !== secret) {
      logger.warn(
        { remoteAddress: req.socket.remoteAddress },
        'Cache-invalidate: rejected (missing or wrong X-Auth-Token)',
      );
      res.statusCode = 401;
      res.end();
      return;
    }
    if (cache === null) {
      // Cold-start race: bot started, listener up, but cache not yet
      // primed because the first AdminClient call is still in flight.
      // Tell the caller to retry rather than silently swallowing.
      logger.warn('Cache-invalidate: bot config cache not initialised yet');
      res.statusCode = 503;
      res.setHeader('Retry-After', '2');
      res.end();
      return;
    }
    try {
      const fresh = await cache.forceInvalidate('admin-pushed');
      res.statusCode = 204;
      res.end();
      logger.info(
        { hadRefresh: fresh !== null },
        'Cache-invalidate: succeeded',
      );
    } catch (err: unknown) {
      logger.error({ err }, 'Cache-invalidate: forceInvalidate threw');
      res.statusCode = 500;
      res.end();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Cache-invalidate HTTP listener up');
  });
  server.on('error', (err) => {
    logger.error({ err, port }, 'Cache-invalidate HTTP server error');
  });
}

startBot().catch((err: unknown) => {
  // No logger yet (the failure happened during bootstrap before
  // createLogger ran); fall back to console.error so the operator sees
  // *something* instead of a silent crash.
  // eslint-disable-next-line no-console
  console.error('[reiwa-bot] startup failed:', err);
  process.exit(1);
});
