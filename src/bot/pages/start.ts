/**
 * `/start` page + `menu:main` callback — the entry point and the
 * shared "back to welcome" target for every sub-menu in the bot.
 *
 * `bot.command('start')` flow (cold path — first contact):
 *   1. Bootstrap the user on rezeis-admin so `/api/internal/user/*`
 *      lookups have a record. Adopt the locale the admin echoes back.
 *   2. Channel-subscription gate. When the operator requires a channel
 *      sub, ask the gate (`resolveChannelGateVerdict`) and short-circuit
 *      with the join prompt for a user who is not in the channel.
 *   3. Send the banner photo (if configured) and render the welcome
 *      caption + main keyboard. Photo failures are non-fatal — we
 *      still ship the text reply so users never see a dead bot.
 *
 * `/start` is the one command the gate middleware (`middleware/channel-gate.ts`)
 * lets through unchecked, because the gate here has to run AFTER link consume,
 * the access-mode gate, bootstrap and ad attribution. It is not the only gate:
 * every other private-chat update meets the same verdict and the same prompt in
 * the middleware. The quest deep link gates too (before its quest screen);
 * `payment_return` alone does not.
 *
 * `bot.callbackQuery('menu:main')` flow (warm path — back-navigation):
 *   • Re-render the welcome screen *in place*, STEALTHNET-style —
 *     swapping the message's banner back to the MAIN screen's banner
 *     (via `renderViewWithBanner`) so a sub-screen's custom banner
 *     doesn't linger, and refreshing the caption + keyboard.
 *   • `menu` is answered by the same handler — see where both are registered.
 *   • The render is `showMainMenu`, which a button the bot no longer knows
 *     gets too, with the «Меню обновилось» toast (`pages/stale-button.ts`).
 */
import { InlineKeyboard } from 'grammy';

import { buildProfileSummary } from '../../infrastructure/bot-message/message-builder.js';
import { getPolicyCache, type CachedPolicy } from '../../infrastructure/admin-client/policy-cache.js';
import { channelGateApiFor, channelGateDepsOf, isOwnPrivateChat } from '../lib/bot-channel-gate.js';
import { isSameChannelChat, resolveChannelChatId, resolveChannelGateVerdict } from '../lib/channel-gate.js';
import { configWithin, MESSAGE_CONFIG_BUDGET_MS, TOAST_CONFIG_BUDGET_MS } from '../lib/config-within.js';
import { inlineButton } from '../widgets/inline-button.js';
import { messageCopy, plainCopy } from '../widgets/operator-copy.js';
import { sendChannelJoinPrompt } from './channel-join-prompt.js';
import { replyWithEntities } from './reply.js';
import { PASSWORD_RESET_START_PAYLOAD, replyWithPasswordReset } from './password-reset.js';
import { QUEST_ID_RE, replyWithQuestChannelPrompt, type ChannelTarget } from './quest-channel.js';
import { buildMainKeyboard, resolveSupportDeepLink, isTelegramSafeButtonUrl, attachSigninTokenToUrl, supportPrefill } from '../widgets/main-keyboard.js';
import { pickScreenText, buildScreenKeyboard } from './screen-renderer.js';
import { resolveTrialButton, type TrialEligibilityShape } from '../widgets/trial-button.js';
import type { BotConfig, Subscription, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';
import { isUneditableMessageError } from './edit-message.js';

import { parseDeeplink } from '../../core/types/deeplink.type.js';
import { coerceLocale } from './coerce-locale.js';
import { resolveBannerSource, type BannerPhotoSource } from './banner-resolver.js';
import { renderViewWithBanner, resolveWelcomeBannerRef } from './screen-banner.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';

interface BootstrapSessionShape {
  readonly language?: string;
}

/** What the platform access mode says to a Telegram user before anything else happens. */
export type AccessModeRefusal =
  | 'access_mode.restricted'
  | 'access_mode.reg_blocked_new'
  | 'access_mode.invited_no_code';

/**
 * The access-mode rules `/start` applies to a Telegram user, as the translation
 * key of the refusal — `null` when the user may go on:
 *   - RESTRICTED refuses everyone;
 *   - REG_BLOCKED refuses a user rezeis has no account for;
 *   - INVITED refuses such a user too, unless `/start` carried a referral payload.
 * For the last two the `exists()` probe is cheap (one indexed lookup), and a
 * probe that fails reads as a returning user: rezeis's own gate inside bootstrap
 * is the backstop.
 *
 * «✅ Я подписался» asks the same, with no payload, before its welcome screen.
 * The channel gate hands its prompt — and so that button — to everybody it
 * stops, a newcomer `/start` has just refused included, and a pass must not open
 * the welcome screen of a service that refused them.
 */
export async function accessModeRefusal(
  adminClient: NonNullable<PageDeps['adminClient']>,
  policy: Pick<CachedPolicy, 'accessMode'>,
  telegramId: number,
  startPayload: string,
): Promise<AccessModeRefusal | null> {
  if (policy.accessMode === 'RESTRICTED') return 'access_mode.restricted';
  if (policy.accessMode !== 'REG_BLOCKED' && policy.accessMode !== 'INVITED') return null;
  let isNewUser = false;
  try {
    const probe = await adminClient.user.exists({ telegramId: String(telegramId) });
    isNewUser = probe.exists === false;
  } catch {
    // exists() failed → assume returning user; the admin
    // server-side gate inside bootstrap is the backstop.
  }
  if (!isNewUser) return null;
  if (policy.accessMode === 'REG_BLOCKED') return 'access_mode.reg_blocked_new';
  // INVITED: only reject when the user has NO referral payload on
  // `/start <code>`. The referral deep-link path falls through to bootstrap.
  const hasReferralPayload =
    startPayload.length > 0 && !startPayload.startsWith('link_') && startPayload !== 'payment_return';
  return hasReferralPayload ? null : 'access_mode.invited_no_code';
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
 * rendering — no bootstrap or channel gate side-effects: bootstrap stays
 * in the `/start` cold path, and the gate runs before either caller (in
 * `/start` itself, and in the gate middleware for `menu:main`).
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
  // Operator copy too, so its emoji tokens resolve like the greeting's.
  const { text: safeText, entities: safeEntities } =
    message.text.trim().length > 0
      ? message
      : messageCopy(deps.translator.t('menu.choose_action', lang), botCfg);

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
  const supportUrl = resolveSupportDeepLink(
    supportHandle,
    supportPrefill(deps.translator, lang, botCfg),
  );

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
        customEmojis: botCfg.customEmojis,
        ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
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
 * Resolve the welcome/main screen's banner into what an IN-PLACE render
 * (`menu:main`) needs. Mirrors `sendWelcomeScreen`'s banner chain so the main
 * screen looks identical whether reached cold (`/start`) or warm (back button):
 *
 *   1. Operator's custom banner (`visual.bannerFileId` / `bannerUrl`) → returned
 *      as a `bannerRef` string so `renderScreenWithBanner` resolves + caches it.
 *   2. Else the BUNDLED default banner from the banner store — a local
 *      `assets/banners/...` file (→ `InputFile`) or an override URL. This is the
 *      piece `resolveWelcomeBannerRef` alone misses: without it, returning to the
 *      main screen from a sub-screen banner deleted the photo and dropped the
 *      default banner entirely.
 *
 * Exactly one of `bannerRef` / `bannerSource` is set when a banner applies;
 * both are absent only when the main screen genuinely has no banner.
 */
async function resolveWelcomeBanner(
  deps: PageDeps,
  botCfg: Awaited<ReturnType<PageDeps['getConfig']>>,
  lang: SupportedLocale,
): Promise<{ bannerRef: string | null; bannerSource?: BannerPhotoSource }> {
  const customRef = resolveWelcomeBannerRef(botCfg.visual);
  if (customRef !== null) return { bannerRef: customRef };

  if (deps.bannerStore !== undefined) {
    try {
      const banner = await deps.bannerStore.resolve('default', lang);
      if (banner !== null) {
        if (banner.kind === 'url') return { bannerRef: null, bannerSource: banner.url };
        const { InputFile } = await import('grammy');
        return { bannerRef: null, bannerSource: new InputFile(banner.path) };
      }
    } catch (err: unknown) {
      deps.logger?.warn({ err }, 'menu:main: default banner resolve failed');
    }
  }
  return { bannerRef: null };
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

/**
 * The channel gate as `/start` runs it: the verdict every surface shares
 * (`resolveChannelGateVerdict`, through the gate's own short-timeout client and
 * shared store) and the join prompt every door sends (`sendChannelJoinPrompt`,
 * which always sends from here and records it). `true` when the user was
 * stopped.
 *
 * FRESH, like «✅ Я подписался»: `/start` is what somebody who has just joined
 * sends, and a "not subscribed" remembered from a message a few seconds earlier
 * must not refuse them. (Two `/start`s within the fresh window share one answer;
 * under «Перепроверять подписку» OFF a pass is honoured without asking.)
 *
 * A prompt that cannot be sent still stops the user — the gate middleware
 * does the same for every other update. Letting them in because the refusal
 * could not be delivered would make a send failure a way past the gate.
 *
 * A quest deep link passes its quest. When the quest's channel IS the gate's,
 * the quest screen is the prompt — it asks the user to join exactly that
 * channel, and its verify button passes the gate with a fresh check — so the
 * user is not stopped here. Otherwise the prompt carries the quest id, and
 * «✅ Я подписался» continues to the quest instead of the menu.
 */
async function stoppedAtChannelGate(
  ctx: BotContext,
  deps: PageDeps,
  telegramId: number,
  quest?: { readonly questId: string; readonly target: ChannelTarget | null },
): Promise<boolean> {
  if (deps.adminClient === null) return false;
  let policy: CachedPolicy;
  try {
    policy = await getPolicyCache(deps.adminClient).get();
  } catch (err: unknown) {
    // No policy, no gate: the same fail-open the middleware applies.
    deps.logger?.warn({ err, telegramId }, 'bot/start: the platform policy could not be read; the channel gate is not applied');
    return false;
  }
  // Never throws: a user it cannot check is let in, and the operator is told why.
  const verdict = await resolveChannelGateVerdict(
    channelGateApiFor(ctx, deps),
    policy,
    telegramId,
    channelGateDepsOf(deps),
    { fresh: true },
  );
  if (verdict !== 'not-subscribed') return false;
  const target = quest?.target ?? null;
  if (target !== null && isSameChannelChat(target.chatId, resolveChannelChatId(policy))) return false;
  try {
    await sendChannelJoinPrompt(ctx, deps, policy, target !== null && quest !== undefined ? { questId: quest.questId } : {});
  } catch (err: unknown) {
    deps.logger?.warn({ err, telegramId }, 'bot/start: the channel join prompt could not be sent; the user stays stopped');
  }
  return true;
}

export const registerStartPage: PageRegistrar = (bot, deps) => {
  // The config the short answers below are rendered with: `/start`'s one-line
  // replies, and the RESTRICTED alert of «В меню». Those reads were added with
  // the emoji tokens, where none was made before. Each is asked for AT its
  // answer, after the work before it (link consume, quest target, access mode):
  // a config the panel gives meanwhile is the one used. A refresh against a
  // hung panel must not hold an answer, and every update queued behind it (they
  // are handled one at a time): past the budget, the config the bot holds. The
  // welcome screen reads its own, as it did.
  const copyConfig = (budgetMs: number) => configWithin(deps, budgetMs);

  // ── /start command — cold path with bootstrap + banner ────────────────────
  bot.command('start', async (ctx) => {
    const tgUser = ctx.from;
    if (tgUser === undefined) return;

    // Only in the user's own private chat, and nothing at all anywhere else — no
    // bootstrap, no link consume, no screen. `/start@bot` typed in a group used
    // to post the welcome screen THERE, with the user's fresh single-use sign-in
    // token in «Кабинет» for any member of the group to open first, and a quest
    // link completed its quest there without the gate's channel.
    if (!isOwnPrivateChat(ctx)) return;

    // Every one-line answer below is operator copy: its emoji tokens resolved,
    // with the pack emoji's entity for an owner with Premium.
    const say = async (key: string, lang: SupportedLocale): Promise<void> =>
      replyWithEntities(ctx, messageCopy(deps.translator.t(key, lang), await copyConfig(MESSAGE_CONFIG_BUDGET_MS)));

    // Phase 0: account-linking deep-link. `t.me/<bot>?start=link_<code>`
    // delivers the 6-digit code minted by the web cabinet's "Link
    // Telegram" flow. Consume it BEFORE bootstrap — bootstrapping first
    // would mint a fresh User owning this telegramId, which the consume
    // step then mistakes for a conflicting account
    // (`TELEGRAM_ALREADY_LINKED`). On success the id is attached to the
    // existing web-first reiwa_id instead.
    const startPayload =
      typeof ctx.match === 'string' ? ctx.match.trim() : '';

    // Phase 0a: channel-quest deep link. The cabinet's "Open bot" action sends
    // `t.me/<bot>?start=quest_channel_<questId>`. We show the join + verify
    // keyboard; the actual membership check happens in the fail-closed
    // `quest_channel:<questId>` callback (see pages/quest-channel.ts). Handled
    // before bootstrap so a returning user lands straight on the quest.
    if (startPayload.startsWith('quest_channel_') && deps.adminClient !== null) {
      const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
      const questId = startPayload.slice('quest_channel_'.length).trim();
      // Validate the id against the SAME CUID grammar the strict callback matcher
      // (`quest_channel:<id>`) enforces. Without this, a malformed deep-link payload
      // triggers a wasted upstream call and can build a button whose callback_data
      // the callback then rejects (or that breaches Telegram's 64-byte limit).
      if (!QUEST_ID_RE.test(questId)) {
        await say('quests.channel.retry', lang);
        return;
      }
      let target: ChannelTarget | null = null;
      try {
        target = (await deps.adminClient.quests.channelTarget({
          telegramId: String(tgUser.id),
          questId,
        })) as ChannelTarget;
      } catch (err: unknown) {
        deps.logger?.warn({ err, telegramId: tgUser.id, questId }, 'bot/start: quest_channel target failed');
      }
      // …but not past the channel gate. This branch returns ahead of Phase 2,
      // and the gate middleware lets every `/start` through, so it once showed
      // the quest to a user the gate would have stopped. The target is read
      // first because it decides what a non-subscriber gets: the quest screen
      // itself when the quest's channel is the gate's, the gate prompt carrying
      // the quest otherwise — see `stoppedAtChannelGate`.
      if (await stoppedAtChannelGate(ctx, deps, tgUser.id, { questId, target })) return;
      if (target === null) {
        await say('quests.channel.retry', lang);
        return;
      }
      await replyWithQuestChannelPrompt(ctx, deps, questId, target);
      return;
    }

    // Phase 0b: post-payment return. The payment provider redirects Mini-App
    // buyers to `t.me/<bot>?start=payment_return` (see lib/payment-return-url).
    // Telegram opens this chat; we acknowledge the payment and offer a one-tap
    // button back into the Mini App, where the payment-return screen is already
    // polling the final status. Handled before bootstrap/channel-gate — a
    // returning buyer is an existing user and shouldn't hit either. The only
    // path through `/start` the gate never stops: the payment has already
    // happened, and this message is its acknowledgement.
    if (startPayload === 'payment_return') {
      const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
      // The release waited for the config here; its caption's emoji and icon
      // come from the config the bot holds now whenever the read is late.
      const botCfg = await copyConfig(MESSAGE_CONFIG_BUDGET_MS);
      const keyboard = new InlineKeyboard();
      const miniAppUrl = deps.urls.miniAppUrl;
      const publicWebUrl = deps.urls.publicWebUrl;
      const openAppLabel = inlineButton(
        deps.translator.t('payment_return.open_app', lang),
        botCfg,
      );
      if (isTelegramSafeButtonUrl(miniAppUrl)) {
        keyboard.webApp(openAppLabel, miniAppUrl as string);
      } else if (isTelegramSafeButtonUrl(publicWebUrl)) {
        keyboard.url(openAppLabel, `${publicWebUrl}/payment-return`);
      }
      await replyWithEntities(ctx, messageCopy(deps.translator.t('payment_return.title', lang), botCfg), {
        // Only attach the keyboard when a safe button URL exists; otherwise
        // send the plain acknowledgement (dev/localhost has no HTTPS target).
        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
      return;
    }

    // Phase 0c: "send me a password reset link" from the cabinet's recovery
    // screen (`t.me/<bot>?start=pwreset`). Handled before the access-mode check —
    // which would read an unknown payload as a referral code — before bootstrap
    // (a customer asking to reset a web password already has an account) and
    // before the channel gate, like `payment_return`: this is a way into the
    // WEB cabinet. See `pages/password-reset.ts`.
    if (startPayload === PASSWORD_RESET_START_PAYLOAD) {
      await replyWithPasswordReset(ctx, deps, tgUser.id);
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
        await say(key, lang);
      } catch (err: unknown) {
        deps.logger?.warn(
          { err, telegramId: tgUser.id },
          'bot/start: telegram link consume failed',
        );
        await say('link.error', lang);
      }
      // Fall through to the normal welcome flow so the user lands on the
      // main menu after the link result. Bootstrap below is an upsert by
      // telegramId — harmless now that the id is attached.
    }

    // Phase 0.9: platform access-mode gate. Runs BEFORE bootstrap so a
    // brand-new Telegram user under REG_BLOCKED / RESTRICTED never
    // produces a `User` row in the DB (Property 6).
    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
    if (deps.adminClient !== null) {
      try {
        const policy = await getPolicyCache(deps.adminClient).get();
        const refusal = await accessModeRefusal(deps.adminClient, policy, tgUser.id, startPayload);
        if (refusal !== null) {
          await say(refusal, lang);
          return;
        }
      } catch {
        /* Policy unavailable — fail open and continue with bootstrap. */
      }
    }

    // Referral deep-link: `t.me/<bot>?start=ref_<token>`. Parsed here and
    // forwarded to bootstrap so rezeis can bind the inviter on a brand-new
    // sign-up. Previously `ref_` was never handled — the bot's referral links
    // silently failed to attribute the referrer (no reward was ever granted).
    const deeplink = parseDeeplink(startPayload);
    const referralCode = deeplink.kind === 'referral' ? deeplink.token : undefined;

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
          ...(referralCode !== undefined ? { referralCode } : {}),
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

    // Phase 2: channel-subscription gate. Driven entirely by the platform
    // policy (channelId / channelUsername / channelLink); honours the
    // operator's re-check toggle. The verdict and the join prompt are the ones
    // the gate middleware uses for every other update — see
    // `stoppedAtChannelGate`. The prompt reads the user's locale when it is
    // sent, so a language bootstrap just adopted from rezeis is the one used.
    if (await stoppedAtChannelGate(ctx, deps, tgUser.id)) return;

    // Phase 3: render the welcome screen (banner + greeting + keyboard).
    // Best-effort banner; shared with the post-channel-subscription path.
    await sendWelcomeScreen(ctx, deps);
  });

  // ── menu:main callback — warm path, in-place edit ─────────────────────────
  // Every sub-menu's "В меню" button funnels here (`showMainMenu`).
  const backToMainMenu = (ctx: BotContext): Promise<void> => showMainMenu(ctx, deps);
  bot.callbackQuery('menu:main', backToMainMenu);
  // `menu` is `menu:main` as an operator types it. The panel's notification
  // editor takes a button's callback data as free text, and «Карта бота» has
  // drawn `menu` as the way to the main menu since June — while nothing here
  // answered it, and such a button only spun. The same handler, not a copy:
  // the own-chat rule, the RESTRICTED alert and the banner restore included.
  bot.callbackQuery('menu', backToMainMenu);
};

/** How `showMainMenu` answers the press it draws the menu for. */
export interface MainMenuPress {
  /**
   * A toast to answer the press with, by translator key — `menu.updated`,
   * «Меню обновилось», for a button the bot no longer knows
   * (`pages/stale-button.ts`). Without one the press is answered silently, as
   * «В меню» always was.
   */
  readonly noticeKey?: string;
}

/**
 * The main menu for a pressed button, drawn *in place* on the message the press
 * came from — STEALTHNET-style chrome: «В меню» (`menu:main`, `menu`), and a
 * button the bot no longer knows (`pages/stale-button.ts`,
 * `pages/dynamic-screen.ts`), which is answered with the current menu rather
 * than with an error.
 *
 *  - Only in the user's own chat with the bot: the welcome screen carries the
 *    user's fresh sign-in token, never to be put on a message in a group. The
 *    press is answered silently anywhere else.
 *  - Under RESTRICTED the press gets the "service unavailable" alert and
 *    nothing else — no menu, no Mini App URL, and no notice either.
 *  - A message Telegram will not edit — gone, too old, a media message that
 *    cannot become this screen — gets the menu as a new message instead
 *    (`sendWelcomeScreen`, the `/start` render). It used to get nothing: the
 *    press was answered, the failure logged, and the user saw no menu at all.
 *
 * The channel gate is not asked here: its middleware stands in front of every
 * page (`middleware/channel-gate.ts`), and a press it stops never gets here.
 */
export async function showMainMenu(ctx: BotContext, deps: PageDeps, press: MainMenuPress = {}): Promise<void> {
  if (!isOwnPrivateChat(ctx)) {
    await ctx.answerCallbackQuery();
    return;
  }
  // The config the toast and the alert are rendered with — their words only:
  // a refresh against a hung panel must not hold the spinner, and every update
  // queued behind it. Past the budget, the config the bot holds.
  const toastConfig = (): Promise<BotConfig | null> => configWithin(deps, TOAST_CONFIG_BUDGET_MS);
  // Under RESTRICTED, every callback short-circuits to a "service
  // unavailable" toast — no menu re-render, no Mini App URL.
  if (deps.adminClient !== null) {
    try {
      const policy = await getPolicyCache(deps.adminClient).get();
      if (policy.accessMode === 'RESTRICTED') {
        const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
        // Operator copy in an alert, which carries no entities: glyphs.
        await ctx.answerCallbackQuery({
          text: plainCopy(deps.translator.t('access_mode.restricted', lang), await toastConfig()),
          show_alert: true,
        });
        return;
      }
    } catch {
      /* fail open */
    }
  }
  if (press.noticeKey !== undefined) {
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    // A toast carries no entities either: the operator's emoji as glyphs.
    await ctx.answerCallbackQuery({ text: plainCopy(deps.translator.t(press.noticeKey, lang), await toastConfig()) });
  } else {
    await ctx.answerCallbackQuery();
  }
  const botCfg = await deps.getConfig();
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
  const view = await buildWelcomeView(ctx, deps);
  // Resolve the main screen's banner the SAME way /start does — operator's
  // custom banner OR the bundled default banner — so returning to the menu
  // restores it instead of dropping it (the reported "standard banner
  // disappears after В меню" bug).
  const welcomeBanner = await resolveWelcomeBanner(deps, botCfg, lang);
  try {
    // Restore the MAIN screen's banner (custom or bundled default) instead of
    // a plain caption edit — otherwise a sub-screen's custom banner (e.g. the
    // invite screen's) lingers, or the default banner is dropped, after "В
    // меню". `renderViewWithBanner` swaps to the welcome banner, or deletes a
    // stale photo only when the main screen genuinely has no banner.
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
        throwUneditable: true,
      },
      {
        text: view.text,
        entities: view.entities,
        replyMarkup: view.keyboard,
        bannerRef: welcomeBanner.bannerRef,
        bannerSource: welcomeBanner.bannerSource,
      },
    );
  } catch (err: unknown) {
    if (isUneditableMessageError(err)) {
      // Not the menu's fault, and not the user's: that message cannot show it.
      await sendWelcomeScreen(ctx, deps).catch((sendErr: unknown) => {
        deps.logger?.warn({ err: sendErr, telegramId: ctx.from?.id }, 'menu:main: the menu could not be sent anew');
      });
      return;
    }
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
}
