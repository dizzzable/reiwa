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
import { loadConfig, resolveRezeisAdminUrl } from '../config.js';
import { AdminClient } from '../lib/admin-client.js';
import type { BotConfig, BotMenuButton, TgCustomEmojiEntity } from './types.js';
import {
  buildWelcomeMessage,
  buildSubscriptionCard,
  buildPlansMessage,
  buildReferralMessage,
} from './message-builder.js';
import { t, getUserLang, setUserLang, setTranslations } from './i18n.js';

const config = loadConfig();

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
    { id: 'subscription', emoji: '📦', label: 'Мои подписки', visible: true, order: 0, style: 'primary', onePerRow: false },
    { id: 'buy', emoji: '💳', label: 'Купить подписку', visible: true, order: 1, style: 'success', onePerRow: false },
    { id: 'promo', emoji: '🎁', label: 'Промокод', visible: true, order: 2, style: 'default', onePerRow: false },
    { id: 'referrals', emoji: '👥', label: 'Рефералы', visible: true, order: 3, style: 'default', onePerRow: false },
    { id: 'profile', emoji: '👤', label: 'Профиль', visible: true, order: 4, style: 'default', onePerRow: false },
    { id: 'activity', emoji: '📊', label: 'Активность', visible: true, order: 5, style: 'default', onePerRow: false },
    { id: 'vpn', emoji: '🌐', label: 'Подключиться к VPN', visible: true, order: 6, style: 'danger', onePerRow: true },
    { id: 'miniapp', emoji: '📱', label: 'Открыть приложение', visible: true, order: 7, style: 'default', onePerRow: true },
  ],
  visual: {
    welcomeMessage: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.',
    botDescription: 'Быстрый и надёжный VPN',
    supportUsername: '',
    channelUsername: '',
    subscriptionInfoFormat: 'full',
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

// ── Keyboard builder (STEALTHNET-style with premium emoji support) ─────────────

function buildMainKeyboard(
  buttons: BotMenuButton[],
  miniAppUrl?: string | null,
  lang = 'ru',
): InlineKeyboard {
  const visible = [...buttons]
    .filter((b) => b.visible)
    .sort((a, b) => a.order - b.order);

  const kb = new InlineKeyboard();
  let rowItems = 0;

  for (const btn of visible) {
    const label = `${btn.emoji} ${btn.label}`;

    if (btn.id === 'miniapp') {
      if (!miniAppUrl) continue;
      if (btn.onePerRow || rowItems > 0) {
        if (rowItems > 0) kb.row();
        rowItems = 0;
      }
      kb.webApp(label, miniAppUrl);
      kb.row();
      rowItems = 0;
      continue;
    }

    if (btn.id === 'vpn') {
      // VPN button opens subscription page as webApp
      if (!miniAppUrl) continue;
      if (btn.onePerRow || rowItems > 0) {
        if (rowItems > 0) kb.row();
        rowItems = 0;
      }
      kb.webApp(label, `${miniAppUrl}/subscribe`);
      kb.row();
      rowItems = 0;
      continue;
    }

    if (btn.id === 'support') {
      // Skip — handled via support username link
      continue;
    }

    if (btn.onePerRow) {
      if (rowItems > 0) {
        kb.row();
        rowItems = 0;
      }
      kb.text(label, btn.id);
      kb.row();
      rowItems = 0;
    } else {
      kb.text(label, btn.id);
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
      features.miniAppEnabled && config.REIWA_PUBLIC_WEB_URL ? config.REIWA_PUBLIC_WEB_URL : null;

    const keyboard = buildMainKeyboard(botCfg.buttons, miniAppUrl, getUserLang(tgUser.id));
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
      botCfg.features.miniAppEnabled && config.REIWA_PUBLIC_WEB_URL ? config.REIWA_PUBLIC_WEB_URL : null;
    const keyboard = buildMainKeyboard(botCfg.buttons, miniAppUrl, getUserLang(tgUser.id));

    await ctx.reply(t('menu.choose_action', getUserLang(tgUser.id)), { reply_markup: keyboard });
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
    const miniAppUrl = botCfg.features.miniAppEnabled && config.REIWA_PUBLIC_WEB_URL ? config.REIWA_PUBLIC_WEB_URL : null;
    const keyboard = buildMainKeyboard(botCfg.buttons, miniAppUrl, lang);
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
