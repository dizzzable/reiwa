/**
 * `/start` page + `menu:main` callback — the entry point and the
 * shared "back to welcome" target for every sub-menu in the bot.
 *
 * `bot.command('start')` flow (cold path — first contact):
 *   1. Bootstrap the user on rezeis-admin so `/api/internal/user/*`
 *      lookups have a record. Adopt the locale the admin echoes back.
 *   2. Channel-subscription gate. When the operator requires a channel
 *      sub, probe membership and short-circuit with the join-channel
 *      reply for `left` / `kicked` users.
 *   3. Send the banner photo (if configured) and render the welcome
 *      caption + main keyboard. Photo failures are non-fatal — we
 *      still ship the text reply so users never see a dead bot.
 *
 * `bot.callbackQuery('menu:main')` flow (warm path — back-navigation):
 *   • Re-render the welcome screen *in place*, STEALTHNET-style —
 *     swapping the message's banner back to the MAIN screen's banner
 *     (via `renderViewWithBanner`) so a sub-screen's custom banner
 *     doesn't linger, and refreshing the caption + keyboard.
 */
import { InlineKeyboard } from 'grammy';

import { renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';
import { buildProfileSummary } from '../../infrastructure/bot-message/message-builder.js';
import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import {
  isChannelGateActive,
  resolveChannelChatId,
  resolveChannelJoinUrl,
  isSubscribedStatus,
  hasRecentlyPassedChannel,
  markChannelPassed,
} from '../lib/channel-gate.js';
import { buildMainKeyboard, resolveSupportDeepLink, isTelegramSafeButtonUrl, attachSigninTokenToUrl } from '../widgets/main-keyboard.js';
import { pickScreenText, buildScreenKeyboard } from './screen-renderer.js';
import { resolveTrialButton, type TrialEligibilityShape } from '../widgets/trial-button.js';
import type { Subscription, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';

import { coerceLocale } from './coerce-locale.js';
import { resolveBannerSource } from './banner-resolver.js';
import { renderViewWithBanner, resolveWelcomeBannerRef } from './screen-banner.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';

interface BootstrapSessionShape {
  readonly language?: string;
}

/** A subscription counts as "active" when ACTIVE or LIMITED (not expired/deleted). */
function hasActiveSubscription(subscriptions: readonly Subscription[]): boolean {
  return subscriptions.some((s) => s.status === 'ACTIVE' || s.status === 'LIMITED');
}

interface CatalogPlanShape {
  readonly isTrial?: boolean;
  readonly trialFree?: boolean;
  readonly durations?: ReadonlyArray<{
    readonly prices?: ReadonlyArray<{ readonly price: number | string; readonly currency: string }>;
  }>;
}

const TRIAL_PRICE_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  RUB: '₽',
  USDT: '$',
  TON: 'TON',
};

/**
 * Lowest price across a paid trial plan's durations, formatted with the
 * currency symbol (e.g. "$2.00"). Returns `null` when no price is available.
 */
function extractTrialPriceLabel(plans: readonly CatalogPlanShape[]): string | null {
  const trialPlan = plans.find((p) => p.isTrial === true && p.trialFree === false);
  if (trialPlan === undefined) return null;
  const prices = (trialPlan.durations ?? []).flatMap((d) =>
    (d.prices ?? []).map((p) => ({ amount: Number(p.price), currency: p.currency })),
  );
  if (prices.length === 0) return null;
  const cheapest = prices.reduce((min, p) => (p.amount < min.amount ? p : min), prices[0]);
  const symbol = TRIAL_PRICE_CURRENCY_SYMBOLS[cheapest.currency] ?? '';
  return `${symbol}${cheapest.amount.toFixed(2)}`;
}

/**
 * Build the welcome message text + main keyboard that both the
 * `/start` command and the `menu:main` callback render. Pure
 * rendering — no bootstrap or channel gate side-effects, those stay
 * in the `/start` cold path.
 */
async function buildWelcomeView(
  ctx: BotContext,
  deps: PageDeps,
): Promise<{
  readonly text: string;
  readonly entities: readonly TgCustomEmojiEntity[];
  readonly keyboard: InlineKeyboard;
}> {
  const tgUser = ctx.from;
  const firstName = tgUser?.first_name ?? '';
  const lang = coerceLocale(deps.userLocale.getSync(tgUser?.id ?? 0));
  const botCfg = await deps.getConfig();

  // Start-screen override: when the operator published a flow whose root
  // ("Стартовый экран") screen has copy, it drives the /start greeting —
  // replacing the static `visual.welcomeMessage`. Locale-aware via
  // `pickScreenText` (EN copy for EN users, RU fallback otherwise). When no
  // root screen exists, fall back to the welcome message, honouring its
  // optional EN override (`bot.welcome_message@en`).
  const rootScreen =
    botCfg.screens?.find(
      (s) => s.isRoot && (s.textRu.trim().length > 0 || s.textEn.trim().length > 0),
    ) ?? null;
  const welcomeTemplate = rootScreen
    ? pickScreenText(rootScreen, lang)
    : lang === 'en' &&
        typeof botCfg.visual.welcomeMessageEn === 'string' &&
        botCfg.visual.welcomeMessageEn.trim().length > 0
      ? botCfg.visual.welcomeMessageEn
      : botCfg.visual.welcomeMessage;

  const subscriptions = await (async (): Promise<readonly Subscription[]> => {
    if (deps.adminClient === null || tgUser === undefined) return [];
    try {
      const res = (await deps.adminClient.subscription.getAll({
        telegramId: String(tgUser.id),
      })) as { subscriptions?: Subscription[] } | null;
      return res?.subscriptions ?? [];
    } catch {
      // Best-effort: a probe failure (or an admin client without the
      // subscription namespace) must not break the welcome render.
      return [];
    }
  })();

  const message =
    botCfg.visual.subscriptionInfoFormat === 'minimal'
      ? buildProfileSummary({
          firstName,
          subscriptions: [],
          welcomeTemplate,
          botEmojis: botCfg.botEmojis,
          customEmojis: botCfg.customEmojis,
          ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
          translator: deps.translator,
          lang,
        })
      : buildProfileSummary({
          firstName,
          subscriptions,
          welcomeTemplate,
          botEmojis: botCfg.botEmojis,
          customEmojis: botCfg.customEmojis,
          ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
          translator: deps.translator,
          lang,
        });

  // A suppressed greeting (operator hid `bot.welcome_message`) can leave the
  // message empty when the user has no subscriptions. Telegram rejects empty
  // text, so fall back to a neutral "choose an action" line — NOT the welcome
  // default (that would defeat the operator's intent to hide the greeting).
  const safeText =
    message.text.trim().length > 0
      ? message.text
      : deps.translator.t('menu.choose_action', lang);
  const safeEntities = message.text.trim().length > 0 ? message.entities : [];

  const miniAppUrl =
    botCfg.features.miniAppEnabled && deps.urls.miniAppUrl !== null
      ? deps.urls.miniAppUrl
      : null;
  // Resolve the support deep-link from the same fallback chain the
  // help-callback page used to follow: admin-managed
  // `BotConfig.visual.supportUsername` first, env
  // `BOT_SUPPORT_USERNAME` second. Numeric / empty handles return
  // null so the support button degrades to a callback (legacy
  // sub-screen flow) rather than producing a broken URL.
  const adminHandle = botCfg.visual.supportUsername.replace(/^@+/, '').trim();
  const supportHandle =
    adminHandle.length > 0 ? adminHandle : (deps.envSupportUsername ?? '').trim();
  const supportPrefill = deps.translator.t('help.contact_prefill', lang);
  const supportUrl = resolveSupportDeepLink(supportHandle, supportPrefill);

  // Issue a one-time magic-link token for URL-kind buttons (Cabinet)
  // so the user lands in the SPA pre-authenticated. Best-effort: if
  // admin is unreachable or returns null, the URL stays clean and
  // the SPA punts the user to /sign-in.
  let signinToken: string | null = null;
  if (deps.adminClient !== null && tgUser !== undefined) {
    try {
      const issued = await deps.adminClient.webAuth.issueBotSigninToken(String(tgUser.id));
      signinToken = issued.token;
    } catch (err: unknown) {
      deps.logger?.warn(
        { err, telegramId: tgUser.id },
        'bot/start: bot-signin token issuance failed; falling back to tokenless URL',
      );
    }
  }

  // Trial button (Property 5/6/10/11): a primary, premium-emoji button shown to
  // subscription-less users that deep-links into the cabinet (Mini App when
  // available, else the magic-link URL) where the trial activates. Best-effort:
  // any probe failure simply hides the button rather than blocking the menu.
  let trialButton = null;
  if (deps.adminClient !== null && tgUser !== undefined) {
    const subscribed = hasActiveSubscription(subscriptions);
    if (!subscribed) {
      let eligibility: TrialEligibilityShape | null = null;
      try {
        eligibility = (await deps.adminClient.trial.getEligibility({
          telegramId: String(tgUser.id),
        })) as TrialEligibilityShape | null;
      } catch (err: unknown) {
        deps.logger?.warn({ err, telegramId: tgUser.id }, 'bot/start: trial eligibility probe failed');
      }
      // Only pay for the catalog round-trip when a paid trial is configured.
      let paidTrialPriceLabel: string | null = null;
      if (eligibility?.reason === 'TRIAL_REQUIRES_PAYMENT') {
        try {
          const plans = (await deps.adminClient.catalog.getPublicPlans({
            telegramId: String(tgUser.id),
          })) as
            | CatalogPlanShape[]
            | null;
          paidTrialPriceLabel = extractTrialPriceLabel(plans ?? []);
        } catch (err: unknown) {
          deps.logger?.warn({ err, telegramId: tgUser.id }, 'bot/start: trial catalog probe failed');
        }
      }
      const cabinetUrl =
        deps.urls.publicWebUrl !== null && deps.urls.publicWebUrl !== undefined
          ? attachSigninTokenToUrl(`${deps.urls.publicWebUrl}/dashboard`, signinToken)
          : null;
      trialButton = resolveTrialButton({
        hasActiveSubscription: false,
        eligibility,
        paidTrialPriceLabel,
        miniAppUrl,
        cabinetUrl,
        botEmojis: botCfg.botEmojis,
        translator: deps.translator,
        lang,
      });
    }
  }

  const keyboard = buildMainKeyboard({
    buttons: botCfg.buttons,
    miniAppUrl,
    publicWebUrl: deps.urls.publicWebUrl,
    lang,
    translator: deps.translator,
    supportUrl,
    signinToken,
    trialButton,
    botEmojis: botCfg.botEmojis,
    customEmojis: botCfg.customEmojis,
    ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
  });

  // When the start-screen override defines its own buttons, render them
  // ABOVE the standard main keyboard so operators can add custom CTAs
  // without losing the cabinet / invite / trial menu below.
  if (rootScreen !== null && rootScreen.buttons.length > 0) {
    const screenKb = buildScreenKeyboard(
      rootScreen,
      lang,
      deps.urls.publicWebUrl,
      miniAppUrl,
      {
        botEmojis: botCfg.botEmojis,
        customEmojis: botCfg.customEmojis,
        ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
        supportUrl,
      },
    );
    if (screenKb.inline_keyboard.length > 0) {
      const merged = new InlineKeyboard([
        ...screenKb.inline_keyboard,
        ...keyboard.inline_keyboard,
      ]);
      return { text: safeText, entities: safeEntities, keyboard: merged };
    }
  }

  return { text: safeText, entities: safeEntities, keyboard };
}

/**
 * In-memory cache of the Telegram `file_id` for the operator banner, keyed by
 * its configured URL. The first send uploads the banner (downloading the bytes
 * from rezeis for `/uploads/...` URLs) and Telegram returns a reusable
 * `file_id`; every subsequent /start reuses it — no re-download, no re-upload
 * to Telegram, and no per-request dependency on rezeis. Eliminates the visible
 * "banner under-loads / re-uploads each time" lag. Dropped for a URL when a
 * send with the cached id fails (stale id), so the next /start re-uploads.
 */
const bannerFileIdCache = new Map<string, string>();

function rememberBannerFileId(url: string, sent: unknown): string | undefined {
  const photo = (sent as { photo?: Array<{ file_id?: string }> } | undefined)?.photo;
  const fileId =
    Array.isArray(photo) && photo.length > 0 ? photo[photo.length - 1]?.file_id : undefined;
  if (typeof fileId === 'string' && fileId.length > 0) {
    // Bound the cache — operators have one or two banners; clear if it grows.
    if (bannerFileIdCache.size > 16) bannerFileIdCache.clear();
    bannerFileIdCache.set(url, fileId);
    return fileId;
  }
  return undefined;
}

/**
 * Send the full welcome screen (banner + greeting caption + main keyboard),
 * exactly as the `/start` cold path does. Shared so warm entry points (e.g.
 * the post-channel-subscription `check_channel` callback) render an identical
 * screen instead of a bare keyboard with no banner. Banner is best-effort:
 * operator banner → bundled default → plain-text reply.
 */
export async function sendWelcomeScreen(ctx: BotContext, deps: PageDeps): Promise<void> {
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
  const botCfg = await deps.getConfig();
  const view = await buildWelcomeView(ctx, deps);

  if (typeof botCfg.visual.bannerUrl === 'string' && botCfg.visual.bannerUrl.length > 0) {
    const bannerUrl = botCfg.visual.bannerUrl;
    // Reuse the cached Telegram file_id when we have one (instant, no fetch).
    // On a cold start the in-memory map is empty, so fall back to the
    // file_id persisted in the last-known-good snapshot (Workstream 4) —
    // a custom banner then re-sends instantly even before the first
    // upstream config fetch lands.
    const persistedFileId =
      typeof botCfg.visual.bannerFileId === 'string' && botCfg.visual.bannerFileId.length > 0
        ? botCfg.visual.bannerFileId
        : undefined;
    if (persistedFileId !== undefined && !bannerFileIdCache.has(bannerUrl)) {
      bannerFileIdCache.set(bannerUrl, persistedFileId);
    }
    const cachedFileId = bannerFileIdCache.get(bannerUrl);
    const photoSource =
      cachedFileId ??
      (await resolveBannerSource(bannerUrl, {
        rezeisAdminUrl: deps.urls.rezeisAdminUrl,
        logger: deps.logger
          ? {
              warn: (obj, msg) => {
                deps.logger?.warn(obj as Record<string, unknown>, msg);
              },
            }
          : undefined,
      }));
    if (photoSource !== null) {
      try {
        const sent = await ctx.replyWithPhoto(photoSource, {
          caption: view.text,
          caption_entities: view.entities.length > 0 ? [...view.entities] : undefined,
          reply_markup: view.keyboard,
        });
        // Cache the file_id Telegram assigned so future sends skip the upload,
        // and stamp it into the durable snapshot so it survives a restart.
        if (cachedFileId === undefined) {
          const resolved = rememberBannerFileId(bannerUrl, sent);
          if (resolved !== undefined) deps.rememberBannerFileId?.(bannerUrl, resolved);
        }
        return;
      } catch (err: unknown) {
        // A stale cached file_id can 400 — drop it so the next /start re-uploads.
        if (cachedFileId !== undefined) bannerFileIdCache.delete(bannerUrl);
        deps.logger?.warn(
          { err, bannerUrl },
          'bot/start banner send failed',
        );
      }
    }
  } else if (deps.bannerStore !== undefined) {
    try {
      const banner = await deps.bannerStore.resolve('default', lang);
      if (banner !== null) {
        if (banner.kind === 'url') {
          await ctx.replyWithPhoto(banner.url, {
            caption: view.text,
            caption_entities: view.entities.length > 0 ? [...view.entities] : undefined,
            reply_markup: view.keyboard,
          });
        } else {
          const { InputFile } = await import('grammy');
          await ctx.replyWithPhoto(new InputFile(banner.path), {
            caption: view.text,
            caption_entities: view.entities.length > 0 ? [...view.entities] : undefined,
            reply_markup: view.keyboard,
          });
        }
        return;
      }
    } catch (err: unknown) {
      deps.logger?.warn({ err }, 'bot/start banner-store send failed');
    }
  }

  await ctx.reply(view.text, {
    entities: view.entities.length > 0 ? [...view.entities] : undefined,
    reply_markup: view.keyboard,
  });
}

/**
 * Extracts the advertising tracking code from a `/start ad_<code>` payload.
 * Returns `null` when the payload is not an advertising payload or the code is
 * malformed (so the existing link/referral routing is unaffected). Mirrors the
 * rezeis `parseAdPayload` contract: `ad_` prefix + `[A-Za-z0-9_-]{3,32}` code.
 */
function parseAdCode(payload: string): string | null {
  if (!payload.startsWith('ad_')) {
    return null;
  }
  const code = payload.slice(3);
  return /^[A-Za-z0-9_-]{3,32}$/.test(code) ? code : null;
}

export const registerStartPage: PageRegistrar = (bot, deps) => {
  // ── /start command — cold path with bootstrap + banner ────────────────────
  bot.command('start', async (ctx) => {
    const tgUser = ctx.from;
    if (tgUser === undefined) return;

    // Phase 0: account-linking deep-link. `t.me/<bot>?start=link_<code>`
    // delivers the 6-digit code minted by the web cabinet's "Link
    // Telegram" flow. Consume it BEFORE bootstrap — bootstrapping first
    // would mint a fresh User owning this telegramId, which the consume
    // step then mistakes for a conflicting account
    // (`TELEGRAM_ALREADY_LINKED`). On success the id is attached to the
    // existing web-first reiwa_id instead.
    const startPayload =
      typeof ctx.match === 'string' ? ctx.match.trim() : '';

    // Phase 0a: post-payment return. The payment provider redirects Mini-App
    // buyers to `t.me/<bot>?start=payment_return` (see lib/payment-return-url).
    // Telegram opens this chat; we acknowledge the payment and offer a one-tap
    // button back into the Mini App, where the payment-return screen is already
    // polling the final status. Handled before bootstrap/channel-gate — a
    // returning buyer is an existing user and shouldn't hit either.
    if (startPayload === 'payment_return') {
      const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
      const keyboard = new InlineKeyboard();
      const miniAppUrl = deps.urls.miniAppUrl;
      const publicWebUrl = deps.urls.publicWebUrl;
      if (isTelegramSafeButtonUrl(miniAppUrl)) {
        keyboard.webApp(deps.translator.t('payment_return.open_app', lang), miniAppUrl as string);
      } else if (isTelegramSafeButtonUrl(publicWebUrl)) {
        keyboard.url(
          deps.translator.t('payment_return.open_app', lang),
          `${publicWebUrl}/payment-return`,
        );
      }
      await ctx.reply(deps.translator.t('payment_return.title', lang), {
        // Only attach the keyboard when a safe button URL exists; otherwise
        // send the plain acknowledgement (dev/localhost has no HTTPS target).
        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
      return;
    }

    if (startPayload.startsWith('link_') && deps.adminClient !== null) {
      const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
      const code = startPayload.slice('link_'.length).trim();
      try {
        const result = await deps.adminClient.linking.telegram.consume(
          String(tgUser.id),
          code,
        );
        let key = 'link.success';
        if (!result.success) {
          switch (result.reason) {
            case 'TELEGRAM_ALREADY_LINKED':
              key = 'link.already_linked';
              break;
            case 'USER_NOT_FOUND':
              key = 'link.user_not_found';
              break;
            case 'INVALID_OR_EXPIRED_CODE':
            default:
              key = 'link.invalid';
              break;
          }
        }
        await ctx.reply(deps.translator.t(key, lang));
      } catch (err: unknown) {
        deps.logger?.warn(
          { err, telegramId: tgUser.id },
          'bot/start: telegram link consume failed',
        );
        await ctx.reply(deps.translator.t('link.error', lang));
      }
      // Fall through to the normal welcome flow so the user lands on the
      // main menu after the link result. Bootstrap below is an upsert by
      // telegramId — harmless now that the id is attached.
    }

    // Phase 0.9: platform access-mode gate. Runs BEFORE bootstrap so a
    // brand-new Telegram user under REG_BLOCKED / RESTRICTED never
    // produces a `User` row in the DB (Property 6).
    let lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
    if (deps.adminClient !== null) {
      try {
        const policy = await getPolicyCache(deps.adminClient).get();
        if (policy.accessMode === 'RESTRICTED') {
          await ctx.reply(deps.translator.t('access_mode.restricted', lang));
          return;
        }
        // For INVITED + REG_BLOCKED we additionally need to know whether
        // the Telegram user is brand-new. The exists() probe is cheap
        // (one indexed lookup) and tolerant of upstream failures.
        if (policy.accessMode === 'REG_BLOCKED' || policy.accessMode === 'INVITED') {
          let isNewUser = false;
          try {
            const probe = await deps.adminClient.user.exists({ telegramId: String(tgUser.id) });
            isNewUser = probe.exists === false;
          } catch {
            // exists() failed → assume returning user; the admin
            // server-side gate inside bootstrap is the backstop.
          }
          if (isNewUser) {
            if (policy.accessMode === 'REG_BLOCKED') {
              await ctx.reply(deps.translator.t('access_mode.reg_blocked_new', lang));
              return;
            }
            // INVITED: only reject when the user has NO referral payload
            // on `/start <code>`. Existing referral deep-link path falls
            // through to bootstrap as today.
            const hasReferralPayload =
              startPayload.length > 0 &&
              !startPayload.startsWith('link_') &&
              startPayload !== 'payment_return';
            if (!hasReferralPayload) {
              await ctx.reply(deps.translator.t('access_mode.invited_no_code', lang));
              return;
            }
          }
        }
      } catch {
        /* Policy unavailable — fail open and continue with bootstrap. */
      }
    }

    // Phase 1: bootstrap user. Failures non-fatal.
    if (deps.adminClient !== null) {
      try {
        const fullName = tgUser.last_name
          ? `${tgUser.first_name} ${tgUser.last_name}`
          : tgUser.first_name;
        const session = (await deps.adminClient.user.bootstrap({
          telegramId: String(tgUser.id),
          username: tgUser.username,
          name: fullName,
          language: tgUser.language_code?.toUpperCase() ?? 'RU',
        })) as BootstrapSessionShape | null;
        if (session?.language) {
          deps.userLocale.setSync(tgUser.id, session.language.toLowerCase());
        }
      } catch (err: unknown) {
        if (deps.logger !== undefined) {
          deps.logger.warn(
            { err, telegramId: tgUser.id },
            'bot/start bootstrap error',
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(
            '[bot/start] bootstrap error:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Re-resolve locale: bootstrap may have updated it from the admin response.
    lang = coerceLocale(deps.userLocale.getSync(tgUser.id));

    // Phase 1.5: advertising attribution. When the deep-link carried an
    // `ad_<code>` payload, record the click + first-touch acquisition in rezeis
    // now that the user row exists. Done BEFORE the channel gate so attribution
    // is persisted (on the User row) even if the user must subscribe first.
    // Best-effort: a failure must never break the welcome flow.
    const adCode = parseAdCode(startPayload);
    if (adCode !== null && deps.adminClient !== null) {
      try {
        await deps.adminClient.advertising.recordClick({
          code: adCode,
          telegramId: String(tgUser.id),
        });
      } catch (err: unknown) {
        deps.logger?.warn(
          { err, telegramId: tgUser.id },
          'bot/start: advertising click ingest failed',
        );
      }
    }

    const botCfg = await deps.getConfig();

    // Phase 2: channel-subscription gate. Driven entirely by the platform
    // policy (channelId / channelUsername / channelLink); honours the
    // operator's re-check toggle.
    if (deps.adminClient !== null) {
      try {
        const policy = await getPolicyCache(deps.adminClient).get();
        if (policy !== null && isChannelGateActive(policy)) {
          const relaxed = policy.channelRecheck === false;
          if (!(relaxed && hasRecentlyPassedChannel(tgUser.id))) {
            const chatId = resolveChannelChatId(policy);
            try {
              const member = await ctx.api.getChatMember(chatId as string | number, tgUser.id);
              if (!isSubscribedStatus(member.status)) {
                const joinUrl = resolveChannelJoinUrl(policy);
                // Resolve premium custom-emoji tokens (`:slug:`) on the gate
                // button labels the same way every other keyboard does — a
                // leading token is promoted to `icon_custom_emoji_id` (premium
                // owners) with a unicode fallback, so operators can put a pack
                // emoji on "Перейти в канал" / "Я подписался" without the raw
                // `:slug:` leaking into the caption.
                const renderGate = (
                  label: string,
                ): { text: string; icon_custom_emoji_id?: string } => {
                  const r = renderButtonLabel(
                    label,
                    botCfg.botEmojis,
                    botCfg.customEmojis,
                    botCfg.botEmojiOwnerHasPremium ?? true,
                  );
                  return r.iconCustomEmojiId !== undefined
                    ? { text: r.text, icon_custom_emoji_id: r.iconCustomEmojiId }
                    : { text: r.text };
                };
                const keyboard = new InlineKeyboard();
                if (joinUrl !== null) {
                  keyboard.url(renderGate(deps.translator.t('channel.join_button', lang)), joinUrl).row();
                }
                keyboard.text(renderGate(deps.translator.t('channel.check_button', lang)), 'check_channel');
                await ctx.reply(deps.translator.t('channel.required', lang), {
                  reply_markup: keyboard,
                });
                return;
              }
              markChannelPassed(tgUser.id);
            } catch {
              /* getChatMember failed (bot not admin / Telegram 5xx) — fail open. */
            }
          }
        }
      } catch {
        /* Platform policy unavailable — fall through. */
      }
    }

    // Phase 3: render the welcome screen (banner + greeting + keyboard).
    // Best-effort banner; shared with the post-channel-subscription path.
    await sendWelcomeScreen(ctx, deps);
  });

  // ── menu:main callback — warm path, in-place edit ─────────────────────────
  // Every sub-menu's "В меню" button funnels here. Render the welcome
  // view *in place* on the existing message instead of sending a new
  // one — STEALTHNET-style chrome.
  bot.callbackQuery('menu:main', async (ctx) => {
    // Under RESTRICTED, every callback short-circuits to a "service
    // unavailable" toast — no menu re-render, no Mini App URL.
    if (deps.adminClient !== null) {
      try {
        const policy = await getPolicyCache(deps.adminClient).get();
        if (policy.accessMode === 'RESTRICTED') {
          const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
          await ctx.answerCallbackQuery({
            text: deps.translator.t('access_mode.restricted', lang),
            show_alert: true,
          });
          return;
        }
      } catch {
        /* fail open */
      }
    }
    await ctx.answerCallbackQuery();
    const botCfg = await deps.getConfig();
    const view = await buildWelcomeView(ctx, deps);
    try {
      // Restore the MAIN screen's own banner (or none) instead of a plain
      // caption edit — otherwise a sub-screen's custom banner (e.g. the invite
      // screen's) lingers on the message after "В меню". `renderViewWithBanner`
      // swaps to the welcome banner, or deletes a stale photo when the main
      // screen has no banner.
      await renderViewWithBanner(
        ctx,
        {
          rezeisAdminUrl: deps.urls.rezeisAdminUrl,
          logger: deps.logger
            ? {
                warn: (obj, msg): void => {
                  deps.logger?.warn(obj as Record<string, unknown>, msg);
                },
              }
            : undefined,
        },
        {
          text: view.text,
          entities: view.entities,
          replyMarkup: view.keyboard,
          bannerRef: resolveWelcomeBannerRef(botCfg.visual),
        },
      );
    } catch (err: unknown) {
      // Telegram refuses edits when the new content is byte-identical
      // to the old (`message is not modified`) — that's expected when
      // the user double-taps "В меню". Any other failure deserves a
      // log line; the user just sees their previous welcome screen
      // unchanged.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        deps.logger?.warn(
          { err, telegramId: ctx.from?.id },
          'menu:main edit failed',
        );
      }
    }
  });
};
