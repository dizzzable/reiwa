/**
 * `/start` page — the entry point every Telegram user hits first.
 *
 * Three phases:
 *   1. Bootstrap the user on rezeis-admin via
 *      `AdminClient.user.bootstrap` so subsequent `/api/internal/user/*`
 *      calls have a record to look up. Sync the user's locale back from
 *      the admin response when it returns one.
 *   2. Channel-subscription gate. When the operator has configured
 *      `channelUsername` AND the platform policy says
 *      `channelRequired`, probe the user's membership via the Telegram
 *      Bot API and short-circuit with the join-channel reply when the
 *      user is `left` / `kicked`. Probe failures fall through (a 502
 *      from `getChatMember` shouldn't lock legitimate users out).
 *   3. Render the welcome message + main keyboard. Welcome banner
 *      (operator-supplied URL) is best-effort — a broken URL must not
 *      sink the welcome reply.
 */
import { InlineKeyboard } from 'grammy';

import { buildWelcomeMessage } from '../../infrastructure/bot-message/message-builder.js';
import { buildMainKeyboard } from '../widgets/main-keyboard.js';
import type { Subscription } from '../../infrastructure/bot-config/types.js';

import { replyWithEntities } from './reply.js';
import { coerceLocale } from './coerce-locale.js';
import type { PageRegistrar } from './types.js';

interface BootstrapSessionShape {
  readonly language?: string;
}

interface ChannelPolicyShape {
  readonly channelRequired?: boolean;
  readonly channelLink?: string;
  readonly channelId?: string | number;
}

export const registerStartPage: PageRegistrar = (bot, deps) => {
  bot.command('start', async (ctx) => {
    const tgUser = ctx.from;
    if (tgUser === undefined) return;

    // ── Phase 1: bootstrap user ────────────────────────────────────────────
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
        // Bootstrap failures are non-fatal — render the welcome reply
        // anyway so the user is not stuck with an unresponsive bot.
        if (deps.logger !== undefined) {
          deps.logger.warn({ err, telegramId: tgUser.id }, 'bot/start bootstrap error');
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

    // ── Phase 2: channel-subscription gate ────────────────────────────────
    const botCfg = await deps.getConfig();
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
                  .text(deps.translator.t('channel.check_button', lang), 'check_channel'),
              });
              return;
            }
          } catch {
            // getChatMember failed — fall through (let user in).
          }
        }
      } catch {
        // Platform policy unavailable — fall through.
      }
    }

    // ── Phase 3: render welcome ────────────────────────────────────────────
    const subscription = deps.adminClient
      ? ((await deps.adminClient.subscription
          .getActive(String(tgUser.id))
          .catch(() => null)) as Subscription | null)
      : null;

    const message = buildWelcomeMessage({
      firstName: tgUser.first_name,
      subscription,
      welcomeTemplate: botCfg.visual.welcomeMessage,
      format: botCfg.visual.subscriptionInfoFormat,
      botEmojis: botCfg.botEmojis,
    });

    const miniAppUrl =
      botCfg.features.miniAppEnabled && deps.urls.miniAppUrl !== null
        ? deps.urls.miniAppUrl
        : null;
    const keyboard = buildMainKeyboard({
      buttons: botCfg.buttons,
      miniAppUrl,
      publicWebUrl: deps.urls.publicWebUrl,
      lang,
      translator: deps.translator,
    });

    if (
      typeof botCfg.visual.bannerUrl === 'string' &&
      botCfg.visual.bannerUrl.length > 0
    ) {
      // Best-effort — a broken banner URL must not sink the welcome reply.
      try {
        await ctx.replyWithPhoto(botCfg.visual.bannerUrl);
      } catch (err: unknown) {
        if (deps.logger !== undefined) {
          deps.logger.warn(
            { err, bannerUrl: botCfg.visual.bannerUrl },
            'bot/start banner send failed',
          );
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            '[bot/start] banner send failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    await replyWithEntities(ctx, message, { reply_markup: keyboard });
  });
};
