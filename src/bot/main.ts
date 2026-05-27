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
import type { BotConfig, BotMenuButton, TgCustomEmojiEntity } from './types.js';
import {
  buildWelcomeMessage,
  buildSubscriptionCard,
  buildPlansMessage,
  buildReferralMessage,
} from './message-builder.js';
import {
  detectLocaleFromTelegram,
  getUserLang,
  resolveButtonLabel,
  setTranslations,
  setUserLang,
  t,
  userLangCacheHas,
} from './i18n.js';

const config = loadConfig();
const reiwaPublicUrl = resolveReiwaPublicUrl(config);

/**
 * Telegram refuses inline-keyboard URLs that point at `localhost`/127.0.0.1
 * AND `web_app` URLs that aren't HTTPS. Both checks funnel through the
 * same safety gate so dev (where `REIWA_DOMAIN=localhost:5173` resolves
 * to `http://localhost:5173`) doesn't crash the entire `/start` reply
 * with `400 Bad Request`. In production the operator types a real
 * domain and this becomes identical to `reiwaPublicUrl`.
 */
function isTelegramSafeButtonUrl(url: string | null): boolean {
  if (url === null) return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('://localhost') || lower.includes('://127.0.0.1')) return false;
  return true;
}
const reiwaWebAppUrl = isTelegramSafeButtonUrl(reiwaPublicUrl) ? reiwaPublicUrl : null;
const reiwaUrlButtonUrl = isTelegramSafeButtonUrl(reiwaPublicUrl) ? reiwaPublicUrl : null;

// ── Session ───────────────────────────────────────────────────────────────────

interface BotSession {
  step?: string;
}
type BotContext = Context & SessionFlavor<BotSession>;

// ── Bot config cache ──────────────────────────────────────────────────────────

interface ConfigCache {
  data: BotConfig;
  fetchedAt: number;
}

const CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes
let configCache: ConfigCache | null = null;

const DEFAULT_BOT_CONFIG: BotConfig = {
  buttons: [
    { id: 'cabinet', emoji: '', label: 'Мой кабинет', visible: true, order: 0, style: 'primary', onePerRow: true },
    { id: 'invite', emoji: '', label: 'Пригласить', visible: true, order: 1, style: 'default', onePerRow: true },
    { id: 'rules', emoji: '', label: 'Правила', visible: true, order: 2, style: 'default', onePerRow: false },
    { id: 'help', emoji: '', label: 'Помощь', visible: true, order: 3, style: 'default', onePerRow: false },
  ],
  visual: {
    welcomeMessage: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.',
    botDescription: 'Быстрый и надёжный VPN',
    supportUsername: '',
    channelUsername: '',
    subscriptionInfoFormat: 'full',
    bannerUrl: null,
  },
  features: {
    referralsEnabled: true,
    promoCodesEnabled: true,
    trialEnabled: false,
    miniAppEnabled: true,
    activityFeedEnabled: true,
    partnersEnabled: false,
  },
  botEmojis: {},
  menuTextCustomEmojiIds: {},
};

async function getBotConfig(adminClient: AdminClient | null): Promise<BotConfig> {
  if (configCache && Date.now() - configCache.fetchedAt < CONFIG_TTL_MS) {
    return configCache.data;
  }
  if (!adminClient) return DEFAULT_BOT_CONFIG;
  try {
    const data = (await adminClient.getBotConfig()) as BotConfig;
    configCache = { data, fetchedAt: Date.now() };
    // Load translations if available
    if ((data as any).translations) {
      setTranslations((data as any).translations);
    }
    return data;
  } catch (err: unknown) {
    console.warn('[bot] Failed to fetch bot config, using defaults:', (err as Error).message);
    return configCache?.data ?? DEFAULT_BOT_CONFIG;
  }
}

// ── Leading emoji strip (for icon_custom_emoji_id buttons) ────────────────────

const LEADING_EMOJI_RE = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;
function stripLeadingEmoji(text: string): string {
  return text.replace(LEADING_EMOJI_RE, '');
}

// ── Button kind dispatch ────────────────────────────────────────────────────
//
// The admin panel only manages visual properties. The *kind* of each
// well-known buttonId (URL link / Mini App / callback) is hardcoded
// here so admin operators can't accidentally turn "Мой кабинет" into a
// callback that doesn't exist or vice-versa.
//
//   kind: 'url'      — opens an external URL in Telegram's in-app
//                      browser. Used for "Мой кабинет" — pushes the
//                      user out of the bot into a real browser session
//                      for credential setup. Built from `reiwaUrlButtonUrl`
//                      (https + non-localhost gate).
//   kind: 'webapp'   — opens the Mini App. Telegram requires HTTPS;
//                      we drop the button when not configured.
//   kind: 'callback' — emits `callback_data === buttonId`; routed by
//                      reiwa's `bot.callbackQuery(id, ...)` handlers.
//
// Unknown ids default to `callback`.

type ButtonKind = 'url' | 'webapp' | 'callback';

interface ButtonBinding {
  readonly kind: ButtonKind;
  readonly path?: string;
}

const BUTTON_KIND_MAP: Readonly<Record<string, ButtonBinding>> = {
  // Default reiwa keyboard
  cabinet: { kind: 'url', path: '/' },
  invite: { kind: 'callback' },
  rules: { kind: 'callback' },
  help: { kind: 'callback' },
  // Legacy buttons that older deployments may still have configured
  subscription: { kind: 'callback' },
  buy: { kind: 'callback' },
  promo: { kind: 'callback' },
  referrals: { kind: 'callback' },
  profile: { kind: 'callback' },
  activity: { kind: 'callback' },
  vpn: { kind: 'webapp', path: '/subscribe' },
  miniapp: { kind: 'webapp', path: '/' },
  support: { kind: 'callback' },
};

function resolveBinding(buttonId: string): ButtonBinding {
  return BUTTON_KIND_MAP[buttonId] ?? { kind: 'callback' };
}

// ── Keyboard builder (STEALTHNET-style with premium emoji support) ─────────────

function buildMainKeyboard(
  buttons: BotMenuButton[],
  miniAppUrl: string | null | undefined,
  lang: string,
  publicWebUrl: string | null | undefined,
  translations: Readonly<Record<string, string>>,
): InlineKeyboard {
  const visible = [...buttons]
    .filter((b) => b.visible)
    .sort((a, b) => a.order - b.order);

  const kb = new InlineKeyboard();
  let rowItems = 0;
  const closeRowIfNeeded = (force: boolean): void => {
    if (force && rowItems > 0) {
      kb.row();
      rowItems = 0;
    }
  };

  for (const btn of visible) {
    const localisedLabel = resolveButtonLabel(btn.id, btn.label, translations, lang);
    const label = btn.emoji ? `${btn.emoji} ${localisedLabel}` : localisedLabel;
    const binding = resolveBinding(btn.id);
    const path = binding.path ?? '';

    let placed = false;
    if (binding.kind === 'webapp') {
      if (!miniAppUrl) continue;
      closeRowIfNeeded(btn.onePerRow);
      kb.webApp(label, `${miniAppUrl}${path}`);
      placed = true;
    } else if (binding.kind === 'url') {
      if (!publicWebUrl) continue;
      closeRowIfNeeded(btn.onePerRow);
      kb.url(label, `${publicWebUrl}${path}`);
      placed = true;
    } else {
      closeRowIfNeeded(btn.onePerRow);
      kb.text(label, btn.id);
      placed = true;
    }

    if (!placed) continue;
    if (btn.onePerRow) {
      kb.row();
      rowItems = 0;
    } else {
      rowItems++;
      if (rowItems === 2) {
        kb.row();
        rowItems = 0;
      }
    }
  }

  if (rowItems > 0) kb.row();
  return kb;
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

    const keyboard = buildMainKeyboard(
      botCfg.buttons,
      miniAppUrl,
      getUserLang(tgUser.id),
      reiwaUrlButtonUrl,
      botCfg.translations ?? {},
    );
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

  bot.command('help', async (ctx) => {
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);
    const { features } = botCfg;

    const lines = [
      t('help.title', lang),
      t('help.start', lang),
      t('help.subscription', lang),
      t('help.plans', lang),
    ];
    if (features.promoCodesEnabled) lines.push(t('help.promo', lang));
    if (features.referralsEnabled) lines.push(t('help.referral', lang));
    lines.push(t('help.profile', lang));
    lines.push(t('help.lang', lang));
    lines.push(t('help.help', lang));

    await ctx.reply(lines.join('\n'));
  });

  // ── /subscription ──────────────────────────────────────────────────────────

  bot.command('subscription', async (ctx) => {
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    try {
      const sub = adminClient
        ? ((await adminClient.getUserSubscription(telegramId).catch(() => null)) as any)
        : null;

      if (!sub) {
        await ctx.reply(t('subscription.no_active', lang));
        return;
      }

      const message = buildSubscriptionCard({ subscription: sub, botEmojis: botCfg.botEmojis });
      await replyWithEntities(ctx, message);
    } catch {
      await ctx.reply(t('subscription.error', lang));
    }
  });

  // ── /plans ─────────────────────────────────────────────────────────────────

  bot.command('plans', async (ctx) => {
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    try {
      const plans = adminClient ? ((await adminClient.getPublicPlans().catch(() => [])) as any[]) : [];

      if (!plans.length) {
        await ctx.reply(t('plans.empty', lang));
        return;
      }

      const message = buildPlansMessage({ plans, botEmojis: botCfg.botEmojis });
      await replyWithEntities(ctx, message);
    } catch {
      await ctx.reply(t('plans.error', lang));
    }
  });

  // ── /promo ─────────────────────────────────────────────────────────────────

  bot.command('promo', async (ctx) => {
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    if (!botCfg.features.promoCodesEnabled) {
      await ctx.reply(t('promo.disabled', lang));
      return;
    }
    ctx.session.step = 'awaiting_promo_code';
    await ctx.reply(t('promo.enter', lang));
  });

  // ── /referral ──────────────────────────────────────────────────────────────

  bot.command('referral', async (ctx) => {
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    if (!botCfg.features.referralsEnabled) {
      await ctx.reply(t('referral.disabled', lang));
      return;
    }

    try {
      const [summary, invite] = await Promise.all([
        adminClient?.getReferralSummary(telegramId).catch(() => null) as any,
        adminClient?.createReferralInvite(telegramId).catch(() => null) as any,
      ]);

      const inviteLink =
        invite?.token && config.REIWA_PUBLIC_WEB_URL
          ? `${config.REIWA_PUBLIC_WEB_URL}/ref/${invite.token}`
          : t('referral.link_unavailable', lang);

      const message = buildReferralMessage({
        totalReferrals: summary?.totalReferrals ?? summary?.referralsCount ?? 0,
        qualifiedReferrals: summary?.qualifiedReferrals ?? summary?.referralsCount ?? 0,
        inviteLink,
        botEmojis: botCfg.botEmojis,
      });

      await replyWithEntities(ctx, message);
    } catch {
      await ctx.reply(t('referral.error', lang));
    }
  });

  // ── /profile ───────────────────────────────────────────────────────────────

  bot.command('profile', async (ctx) => {
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);

    try {
      const session = adminClient
        ? ((await adminClient.getUserSession(telegramId).catch(() => null)) as any)
        : null;

      if (!session) {
        await ctx.reply(t('error_generic', lang));
        return;
      }

      const lines = [
        `👤 ${t('profile.header', lang)}\n`,
        t('profile.name', lang, { name: session.name ?? '—' }),
      ];
      if (session.username) lines.push(t('profile.username', lang, { username: session.username }));
      lines.push(t('profile.language', lang, { lang: (session.language ?? 'RU').toUpperCase() }));
      lines.push(t('profile.points', lang, { points: session.points ?? 0 }));
      if (session.personalDiscount > 0) {
        lines.push(t('profile.discount', lang, { discount: session.personalDiscount }));
      }
      lines.push(t('profile.referral_code', lang, { code: session.referralCode ?? '—' }));
      lines.push(session.hasSubscription ? t('profile.has_subscription', lang) : t('profile.no_subscription', lang));

      const kb = new InlineKeyboard()
        .text(t('lang.ru', lang), 'lang:ru')
        .text(t('lang.en', lang), 'lang:en')
        .row()
        .text(t('back_to_menu', lang), 'back_to_menu');

      await ctx.reply(lines.join('\n'), { reply_markup: kb });
    } catch {
      await ctx.reply(t('error_generic', lang));
    }
  });

  // ── /lang ──────────────────────────────────────────────────────────────────

  bot.command('lang', async (ctx) => {
    const lang = getUserLang(ctx.from?.id ?? 0);
    const kb = new InlineKeyboard()
      .text(t('lang.ru', lang), 'lang:ru')
      .text(t('lang.en', lang), 'lang:en');
    await ctx.reply(t('lang.choose', lang), { reply_markup: kb });
  });

  // ── Callback queries ───────────────────────────────────────────────────────

  // Language selection
  bot.callbackQuery(/^lang:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const newLang = ctx.match![1];
    const userId = ctx.from?.id ?? 0;
    setUserLang(userId, newLang);

    // Persist language to backend
    if (adminClient) {
      adminClient.updateUserLanguage(String(userId), newLang).catch(() => {});
    }

    const langName = newLang === 'ru' ? 'Русский' : 'English';
    await ctx.reply(t('lang.changed', newLang, { lang: langName }));
  });

  // Back to menu
  bot.callbackQuery('back_to_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgUser = ctx.from;
    if (!tgUser) return;

    const botCfg = await getBotConfig(adminClient);
    const miniAppUrl =
      botCfg.features.miniAppEnabled && reiwaWebAppUrl ? reiwaWebAppUrl : null;
    const keyboard = buildMainKeyboard(
      botCfg.buttons,
      miniAppUrl,
      getUserLang(tgUser.id),
      reiwaUrlButtonUrl,
      botCfg.translations ?? {},
    );

    await ctx.reply(t('menu.choose_action', getUserLang(tgUser.id)), { reply_markup: keyboard });
  });

  // ── Standard keyboard callbacks (invite / rules / help) ───────────────────

  bot.callbackQuery('invite', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    if (!botCfg.features.referralsEnabled) {
      await ctx.reply(t('referral.disabled', lang));
      return;
    }

    try {
      const invite = adminClient
        ? ((await adminClient.createReferralInvite(telegramId).catch(() => null)) as
            | { token?: string }
            | null)
        : null;
      const inviteLink =
        invite?.token && reiwaPublicUrl
          ? `${reiwaPublicUrl}/ref/${invite.token}`
          : t('referral.link_unavailable', lang);
      await ctx.reply(t('invite.share', lang, { link: inviteLink }));
    } catch {
      await ctx.reply(t('referral.error', lang));
    }
  });

  bot.callbackQuery('rules', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = getUserLang(ctx.from?.id ?? 0);
    const policy = adminClient
      ? ((await adminClient.getPlatformPolicy().catch(() => null)) as {
          rulesLink?: string | null;
        } | null)
      : null;
    const link = policy?.rulesLink ?? '';
    if (link.length > 0) {
      const kb = new InlineKeyboard().url(t('rules.open_button', lang), link);
      await ctx.reply(t('rules.intro', lang), { reply_markup: kb });
    } else {
      await ctx.reply(t('rules.unavailable', lang));
    }
  });

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);
    const supportUsername = botCfg.visual.supportUsername.replace(/^@/, '');
    const lines = [t('help.title', lang), t('help.start', lang), t('help.help', lang)];
    if (supportUsername.length > 0) {
      lines.push('');
      lines.push(t('help.contact_support', lang, { username: supportUsername }));
    }
    await ctx.reply(lines.join('\n'));
  });

  // Channel subscription check
  bot.callbackQuery('check_channel', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgUser = ctx.from;
    if (!tgUser) return;
    const lang = getUserLang(tgUser.id);

    try {
      const policy = adminClient ? await adminClient.getPlatformPolicy() as any : null;
      if (policy?.channelRequired && policy?.channelLink) {
        const channelId = policy.channelId ?? policy.channelLink;
        const member = await ctx.api.getChatMember(channelId, tgUser.id);
        if (member.status === 'left' || member.status === 'kicked') {
          await ctx.reply(t('channel.not_subscribed', lang));
          return;
        }
      }
    } catch {
      // Can't verify — let them through
    }

    // Channel check passed — show main menu
    const botCfg = await getBotConfig(adminClient);
    const miniAppUrl = botCfg.features.miniAppEnabled && reiwaWebAppUrl ? reiwaWebAppUrl : null;
    const keyboard = buildMainKeyboard(
      botCfg.buttons,
      miniAppUrl,
      lang,
      reiwaUrlButtonUrl,
      botCfg.translations ?? {},
    );
    await ctx.reply(t('channel.verified', lang), { reply_markup: keyboard });
  });

  // Subscription
  bot.callbackQuery('subscription', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    const sub = adminClient
      ? ((await adminClient.getUserSubscription(telegramId).catch(() => null)) as any)
      : null;

    if (!sub) {
      await ctx.reply(t('subscription.no_active', lang));
      return;
    }

    const message = buildSubscriptionCard({ subscription: sub, botEmojis: botCfg.botEmojis });
    await replyWithEntities(ctx, message);
  });

  // Buy
  bot.callbackQuery('buy', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    const miniAppUrl =
      botCfg.features.miniAppEnabled && config.REIWA_PUBLIC_WEB_URL
        ? config.REIWA_PUBLIC_WEB_URL + '/plans'
        : null;

    if (miniAppUrl) {
      await ctx.reply(t('plans.open_app', lang), {
        reply_markup: new InlineKeyboard().webApp(t('plans.open_app_button', lang), miniAppUrl),
      });
    } else {
      await ctx.reply(t('plans.use_command', lang));
    }
  });

  // Promo
  bot.callbackQuery('promo', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    if (!botCfg.features.promoCodesEnabled) {
      await ctx.reply(t('promo.disabled', lang));
      return;
    }
    ctx.session.step = 'awaiting_promo_code';
    await ctx.reply(t('promo.enter', lang));
  });

  // Referrals
  bot.callbackQuery('referrals', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);
    const botCfg = await getBotConfig(adminClient);

    if (!botCfg.features.referralsEnabled) {
      await ctx.reply(t('referral.disabled', lang));
      return;
    }

    try {
      const summary = adminClient
        ? ((await adminClient.getReferralSummary(telegramId).catch(() => null)) as any)
        : null;
      const invite = adminClient
        ? ((await adminClient.createReferralInvite(telegramId).catch(() => null)) as any)
        : null;

      const inviteLink =
        invite?.token && config.REIWA_PUBLIC_WEB_URL
          ? `${config.REIWA_PUBLIC_WEB_URL}/ref/${invite.token}`
          : t('referral.link_unavailable', lang);

      const message = buildReferralMessage({
        totalReferrals: summary?.totalReferrals ?? summary?.referralsCount ?? 0,
        qualifiedReferrals: summary?.qualifiedReferrals ?? summary?.referralsCount ?? 0,
        inviteLink,
        botEmojis: botCfg.botEmojis,
      });

      await replyWithEntities(ctx, message);
    } catch {
      await ctx.reply(t('referral.error', lang));
    }
  });

  // Profile
  bot.callbackQuery('profile', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);

    try {
      const session = adminClient
        ? ((await adminClient.getUserSession(telegramId).catch(() => null)) as any)
        : null;

      if (!session) {
        await ctx.reply(t('error_generic', lang));
        return;
      }

      const lines = [
        `👤 ${t('profile.header', lang)}\n`,
        t('profile.name', lang, { name: session.name ?? '—' }),
      ];
      if (session.username) lines.push(t('profile.username', lang, { username: session.username }));
      lines.push(t('profile.language', lang, { lang: (session.language ?? 'RU').toUpperCase() }));
      lines.push(t('profile.points', lang, { points: session.points ?? 0 }));
      if (session.personalDiscount > 0) {
        lines.push(t('profile.discount', lang, { discount: session.personalDiscount }));
      }
      lines.push(t('profile.referral_code', lang, { code: session.referralCode ?? '—' }));
      lines.push(session.hasSubscription ? t('profile.has_subscription', lang) : t('profile.no_subscription', lang));

      const kb = new InlineKeyboard()
        .text(t('lang.ru', lang), 'lang:ru')
        .text(t('lang.en', lang), 'lang:en')
        .row()
        .text(t('back_to_menu', lang), 'back_to_menu');

      await ctx.reply(lines.join('\n'), { reply_markup: kb });
    } catch {
      await ctx.reply(t('error_generic', lang));
    }
  });

  // Activity
  bot.callbackQuery('activity', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id);
    const lang = getUserLang(ctx.from?.id ?? 0);

    try {
      const result = adminClient
        ? ((await adminClient.getTransactions(telegramId).catch(() => null)) as any)
        : null;

      const txs = (result?.transactions ?? result?.items ?? []) as Array<Record<string, unknown>>;

      if (!txs.length) {
        await ctx.reply(t('activity.empty', lang));
        return;
      }

      const lines = txs.map((tx) => {
        const pricing = (tx['pricing'] as Record<string, unknown>) ?? {};
        const amount = pricing['finalPrice'] ?? tx['amount'] ?? '—';
        const currency = pricing['currency'] ?? tx['currency'] ?? '';
        const status = String(tx['status'] ?? '');
        const gw = String(tx['gatewayType'] ?? tx['gateway'] ?? '');
        return `• ${gw} — ${amount} ${currency} — ${status}`;
      });

      await ctx.reply(`${t('activity.header', lang)}\n\n${lines.join('\n')}`);
    } catch {
      await ctx.reply(t('activity.error', lang));
    }
  });

  // ── Text handler (promo code entry) ──────────────────────────────────────

  bot.on('message:text', async (ctx) => {
    if (ctx.session.step === 'awaiting_promo_code') {
      ctx.session.step = undefined;
      const code = ctx.message.text.trim();
      const telegramId = String(ctx.from?.id);
      const lang = getUserLang(ctx.from?.id ?? 0);

      try {
        const result = adminClient
          ? ((await adminClient.activatePromocode(telegramId, code)) as any)
          : null;

        if (result?.activated || result?.success) {
          await ctx.reply(`${t('promo.activated', lang)}\n\n${result.message ?? ''}`);
        } else {
          await ctx.reply(t('promo.failed', lang, { code }));
        }
      } catch (e: unknown) {
        await ctx.reply(t('promo.error', lang, { message: (e as Error).message }));
      }
    }
  });

  // ── Error handler ──────────────────────────────────────────────────────────

  bot.catch((err) => {
    console.error('[bot error]', err.message, err.error);
  });

  // ── Config refresh timer ───────────────────────────────────────────────────

  setInterval(() => {
    getBotConfig(adminClient).catch(console.error);
  }, CONFIG_TTL_MS);

  // ── Start ──────────────────────────────────────────────────────────────────

  bot.start({
    onStart: (info) => console.log(`[reiwa-bot] Started as @${info.username}`),
  });
}

startBot().catch(console.error);
