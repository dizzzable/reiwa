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
 *   • Re-render the welcome screen *in place* via `editOrReply`,
 *     STEALTHNET-style. No fresh bootstrap, no banner re-send — we
 *     just refresh the live message's caption + keyboard so the user's
 *     chat stays a single screen instead of a scrolling tower of
 *     replies.
 */
import { InlineKeyboard } from 'grammy';

import { buildWelcomeMessage } from '../../infrastructure/bot-message/message-builder.js';
import { buildMainKeyboard, resolveSupportDeepLink, isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import type { Subscription, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';

import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import { resolveBannerSource } from './banner-resolver.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';

interface BootstrapSessionShape {
  readonly language?: string;
}

interface ChannelPolicyShape {
  readonly channelRequired?: boolean;
  readonly channelLink?: string;
  readonly channelId?: string | number;
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

  const subscription =
    deps.adminClient !== null && tgUser !== undefined
      ? ((await deps.adminClient.subscription
          .getActive({ telegramId: String(tgUser.id) })
          .catch(() => null)) as Subscription | null)
      : null;

  const message = buildWelcomeMessage({
    firstName,
    subscription,
    welcomeTemplate: botCfg.visual.welcomeMessage,
    format: botCfg.visual.subscriptionInfoFormat,
    botEmojis: botCfg.botEmojis,
  });

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

  const keyboard = buildMainKeyboard({
    buttons: botCfg.buttons,
    miniAppUrl,
    publicWebUrl: deps.urls.publicWebUrl,
    lang,
    translator: deps.translator,
    supportUrl,
    signinToken,
  });

  return { text: message.text, entities: message.entities, keyboard };
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

    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));
    const botCfg = await deps.getConfig();

    // Phase 2: channel-subscription gate.
    if (botCfg.visual.channelUsername.length > 0 && deps.adminClient !== null) {
      try {
        const policy = (await deps.adminClient.system.getPlatformPolicy()) as
          | ChannelPolicyShape
          | null;
        if (
          policy?.channelRequired === true &&
          typeof policy.channelLink === 'string' &&
          policy.channelLink.length > 0
        ) {
          const channelId = policy.channelId ?? policy.channelLink;
          try {
            const member = await ctx.api.getChatMember(channelId, tgUser.id);
            if (member.status === 'left' || member.status === 'kicked') {
              const channelUrl = policy.channelLink.startsWith('@')
                ? `https://t.me/${policy.channelLink.slice(1)}`
                : policy.channelLink;
              await ctx.reply(deps.translator.t('channel.required', lang), {
                reply_markup: new InlineKeyboard()
                  .url(deps.translator.t('channel.join_button', lang), channelUrl)
                  .row()
                  .text(
                    deps.translator.t('channel.check_button', lang),
                    'check_channel',
                  ),
              });
              return;
            }
          } catch {
            /* getChatMember failed — fall through and let user in. */
          }
        }
      } catch {
        /* Platform policy unavailable — fall through. */
      }
    }

    // Phase 3: render welcome. Banner is best-effort.
    const view = await buildWelcomeView(ctx, deps);

    if (
      typeof botCfg.visual.bannerUrl === 'string' &&
      botCfg.visual.bannerUrl.length > 0
    ) {
      // Resolve operator-managed banner reference to a sendable
      // photo source. Internal `/uploads/...` URLs are downloaded
      // by reiwa-bot and uploaded to Telegram as multipart, so they
      // don't need to be publicly reachable. Public URLs / file_ids
      // are forwarded verbatim.
      const photoSource = await resolveBannerSource(botCfg.visual.bannerUrl, {
        rezeisAdminUrl: deps.urls.rezeisAdminUrl,
        logger: deps.logger
          ? {
              warn: (obj, msg) => {
                deps.logger?.warn(obj as Record<string, unknown>, msg);
              },
            }
          : undefined,
      });
      if (photoSource !== null) {
        try {
          await ctx.replyWithPhoto(photoSource, {
            caption: view.text,
            caption_entities:
              view.entities.length > 0 ? [...view.entities] : undefined,
            reply_markup: view.keyboard,
          });
          return;
        } catch (err: unknown) {
          deps.logger?.warn(
            { err, bannerUrl: botCfg.visual.bannerUrl },
            'bot/start banner send failed',
          );
          // Fall through — emit a plain reply so the user still gets the menu.
        }
      }
    } else if (deps.bannerStore !== undefined) {
      try {
        const banner = await deps.bannerStore.resolve('default', lang);
        if (banner !== null) {
          if (banner.kind === 'url') {
            await ctx.replyWithPhoto(banner.url, {
              caption: view.text,
              caption_entities:
                view.entities.length > 0 ? [...view.entities] : undefined,
              reply_markup: view.keyboard,
            });
          } else {
            const { InputFile } = await import('grammy');
            await ctx.replyWithPhoto(new InputFile(banner.path), {
              caption: view.text,
              caption_entities:
                view.entities.length > 0 ? [...view.entities] : undefined,
              reply_markup: view.keyboard,
            });
          }
          return;
        }
      } catch (err: unknown) {
        deps.logger?.warn({ err }, 'bot/start banner-store send failed');
      }
    }

    // No banner available — plain text reply.
    await ctx.reply(view.text, {
      entities:
        view.entities.length > 0 ? [...view.entities] : undefined,
      reply_markup: view.keyboard,
    });
  });

  // ── menu:main callback — warm path, in-place edit ─────────────────────────
  // Every sub-menu's "В меню" button funnels here. Render the welcome
  // view *in place* on the existing message instead of sending a new
  // one — STEALTHNET-style chrome.
  bot.callbackQuery('menu:main', async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await buildWelcomeView(ctx, deps);
    try {
      await editOrReply(ctx, {
        text: view.text,
        entities: view.entities,
        replyMarkup: view.keyboard,
      });
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
