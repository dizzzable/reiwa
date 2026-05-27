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

import { Bot, Context, session, SessionFlavor, InlineKeyboard } from 'grammy';
import { loadConfig, resolveRezeisAdminUrl, resolveReiwaPublicUrl } from '../config.js';
import { AdminClient } from '../lib/admin-client.js';
import type { BotConfig, TgCustomEmojiEntity } from '../infrastructure/bot-config/types.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../infrastructure/bot-config/cache.js';
import { translator } from '../infrastructure/i18n/index.js';
import {
  buildWelcomeMessage,
  buildSubscriptionCard,
  buildPlansMessage,
  buildReferralMessage,
} from '../infrastructure/bot-message/message-builder.js';
import {
  buildMainKeyboard as buildMainKeyboardWidget,
  isTelegramSafeButtonUrl,
} from './widgets/main-keyboard.js';
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
  registerSubscriptionPage,
} from './pages/index.js';
import {
  detectLocaleFromTelegram,
  getUserLang,
  setTranslations,
  setUserLang,
  t,
  userLangCacheHas,
} from './i18n.js';
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../core/enums/locale.enum.js';

// `getUserLang` returns a free-form string (legacy bot-shim contract).
// The new keyboard widget takes a `SupportedLocale` so we coerce here
// rather than widening the widget signature.
function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
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

async function getBotConfig(adminClient: AdminClient | null): Promise<BotConfig> {
  if (botConfigCache !== null) return botConfigCache.get();
  if (!adminClient) return DEFAULT_BOT_CONFIG;
  // Lazy construction so an AdminClient set later (tests, hot-reload)
  // gets picked up. In the regular bootstrap path `startBot()` already
  // calls this through a primed cache.
  botConfigCache = new BotConfigCache({
    fetcher: () => adminClient.getBotConfig(),
    hydrator: { setOverrides: (m) => setTranslations(m as Record<string, unknown>) },
    fallback: DEFAULT_BOT_CONFIG,
  });
  return botConfigCache.get();
}

// ── Helper: send reply with entities ─────────────────────────────────────────

async function replyWithEntities(
  ctx: BotContext,
  message: { text: string; entities: TgCustomEmojiEntity[] },
  extra?: Record<string, unknown>,
): Promise<void> {
  await ctx.reply(message.text, {
    entities: message.entities.length > 0 ? message.entities : undefined,
    ...extra,
  });
}

// ── Bot startup ───────────────────────────────────────────────────────────────

async function startBot(): Promise<void> {
  if (!config.BOT_TOKEN) {
    console.warn('[reiwa-bot] BOT_TOKEN not set — bot disabled');
    process.stdin.resume();
    return;
  }

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
  console.log(
    '[reiwa-bot] Bot config loaded. Emoji keys:',
    Object.keys(botConfig.botEmojis ?? {}).length,
    '| Buttons:',
    botConfig.buttons.filter((b) => b.visible).length,
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
    if (tgUser !== undefined && !userLangCacheHas(tgUser.id)) {
      const detected = detectLocaleFromTelegram(tgUser.language_code);
      setUserLang(tgUser.id, detected);
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

  // ── /start ─────────────────────────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    const tgUser = ctx.from;
    if (!tgUser) return;
    const lang = getUserLang(tgUser.id);

    // Bootstrap user in admin backend
    if (adminClient) {
      try {
        const session = (await adminClient.bootstrapUser({
          telegramId: String(tgUser.id),
          username: tgUser.username,
          name: `${tgUser.first_name}${tgUser.last_name ? ' ' + tgUser.last_name : ''}`,
          language: tgUser.language_code?.toUpperCase() ?? 'RU',
        })) as any;
        // Sync language from backend
        if (session?.language) {
          setUserLang(tgUser.id, session.language.toLowerCase());
        }
      } catch (e: unknown) {
        console.error('[bot/start] bootstrap error:', (e as Error).message);
      }
    }

    // Check channel subscription requirement
    const botCfg = await getBotConfig(adminClient);
    if (botCfg.visual.channelUsername && adminClient) {
      try {
        const policy = await adminClient.getPlatformPolicy() as any;
        if (policy?.channelRequired && policy?.channelLink) {
          const channelId = policy.channelId ?? policy.channelLink;
          try {
            const member = await ctx.api.getChatMember(channelId, tgUser.id);
            if (member.status === 'left' || member.status === 'kicked') {
              const channelUrl = policy.channelLink.startsWith('@')
                ? `https://t.me/${policy.channelLink.slice(1)}`
                : policy.channelLink;
              await ctx.reply(
                t('channel.required', lang),
                {
                  reply_markup: new InlineKeyboard()
                    .url(t('channel.join_button', lang), channelUrl)
                    .row()
                    .text(t('channel.check_button', lang), 'check_channel'),
                },
              );
              return;
            }
          } catch {
            // Can't check membership — proceed anyway
          }
        }
      } catch {
        // Platform policy unavailable — proceed
      }
    }

    const { botEmojis, visual, features } = botCfg;

    // Fetch subscription
    let subscription = null;
    if (adminClient) {
      subscription = (await adminClient.getUserSubscription(String(tgUser.id)).catch(() => null)) as any;
    }

    const message = buildWelcomeMessage({
      firstName: tgUser.first_name,
      subscription,
      welcomeTemplate: visual.welcomeMessage,
      format: visual.subscriptionInfoFormat,
      botEmojis,
    });

    const miniAppUrl =
      features.miniAppEnabled && reiwaWebAppUrl ? reiwaWebAppUrl : null;

    const keyboard = buildMainKeyboardWidget({ buttons: botCfg.buttons, miniAppUrl, publicWebUrl: reiwaUrlButtonUrl, lang: coerceLocale(getUserLang(tgUser.id)), translator });
    if (visual.bannerUrl && visual.bannerUrl.length > 0) {
      // Best-effort banner — broken URL must not sink the welcome reply.
      try {
        await ctx.replyWithPhoto(visual.bannerUrl);
      } catch (err: unknown) {
        console.warn('[bot/start] banner send failed:', (err as Error).message);
      }
    }
    await replyWithEntities(ctx, message, { reply_markup: keyboard });
  });

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
      getSync: (id: number) => getUserLang(id),
      setSync: (id: number, lang: string) => setUserLang(id, lang),
      hasSync: (id: number) => userLangCacheHas(id),
    },
    getConfig: () => getBotConfig(adminClient),
    urls: { publicWebUrl: reiwaUrlButtonUrl, miniAppUrl: reiwaWebAppUrl },
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

  // ── back_to_menu / check_channel callbacks (extracted to pages/menu.ts) ───
  // ── buy / promo / referrals / profile / activity callbacks (extracted) ────
  // ── message:text promo-code entry (extracted to pages/promo.ts) ───────────

  // ── Error handler ──────────────────────────────────────────────────────────

  bot.catch((err) => {
    console.error('[bot error]', err.message, err.error);
  });

  // ── Config refresh timer ───────────────────────────────────────────────────
  //
  // The cache auto-refreshes on next `get()` after `ttlMs`, but a
  // periodic warm-fetch keeps the cache hot so the next user request
  // doesn't pay the upstream round-trip.

  const CONFIG_REFRESH_MS = 5 * 60 * 1000;
  setInterval(() => {
    getBotConfig(adminClient).catch((err: unknown) => {
      console.error('[bot] background bot-config refresh failed:', err);
    });
  }, CONFIG_REFRESH_MS);

  // ── Start ──────────────────────────────────────────────────────────────────

  bot.start({
    onStart: (info) => console.log(`[reiwa-bot] Started as @${info.username}`),
  });
}

startBot().catch(console.error);
