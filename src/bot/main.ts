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
import { loadConfig, resolveRezeisAdminUrl, resolveReiwaPublicUrl } from '../config.js';
import { AdminClient } from '../lib/admin-client.js';
import type { BotConfig } from '../infrastructure/bot-config/types.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../infrastructure/bot-config/cache.js';
import { isTelegramSafeButtonUrl } from './widgets/main-keyboard.js';
import {
  registerActivityPage,
  registerBuyPage,
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
    fetcher: () => adminClient.getBotConfig(),
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

  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  bot.use(session({ initial: (): BotSession => ({}) }));

  // ── Locale auto-detect middleware ──────────────────────────────────────────
  //
  // Telegram clients ship the *system* `language_code` of the device on
  // every update. We use it as the auto-detect signal:
  //   - First contact (cache miss): adopt the detected locale, push it
  //     to admin so subsequent sessions across reiwa-bot / reiwa-api /
  //     web stay in sync.
  //   - Returning user with cached locale: trust the cache. The `/lang`
  //     command is the only override path — explicit user choice
  //     always wins over the device language.
  bot.use(async (ctx, next) => {
    const tgUser = ctx.from;
    if (tgUser !== undefined && !userLocaleCache.hasSync(tgUser.id)) {
      const detected = detectLocaleFromTelegram(tgUser.language_code);
      userLocaleCache.setSync(tgUser.id, detected);
      if (adminClient !== null) {
        adminClient
          .updateUserLanguage(String(tgUser.id), detected.toUpperCase())
          .catch(() => {
            /* fire-and-forget — admin learns the locale on next bootstrap */
          });
      }
    }
    await next();
  });

  // ── /start (extracted to bot/pages/start.ts; registered above) ────────────

  // ── /help ──────────────────────────────────────────────────────────────────
  // Extracted to bot/pages/help.ts (registered above).

  // ── /subscription ──────────────────────────────────────────────────────────
  // Extracted to bot/pages/subscription.ts (registered above; same module
  // also handles the `subscription` callback).

  // ── /plans ─────────────────────────────────────────────────────────────────
  // Extracted to bot/pages/plans.ts (registered above).

  // ── /promo ─────────────────────────────────────────────────────────────────

  // ── /promo (extracted to bot/pages/promo.ts) ──────────────────────────────
  // ── /referral (extracted to bot/pages/referral.ts) ─────────────────────────
  // ── /profile (extracted to bot/pages/profile.ts) ───────────────────────────

  // ── /lang and language callback (extracted to bot/pages/lang.ts) ──────────
  // ── invite/rules/help callbacks (extracted to bot/pages/) ────────────────

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

  // ── back_to_menu / check_channel callbacks (extracted to pages/menu.ts) ───
  // ── buy / promo / referrals / profile / activity callbacks (extracted) ────
  // ── message:text promo-code entry (extracted to pages/promo.ts) ───────────

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

  bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'reiwa-bot started'),
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
