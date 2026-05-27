/**
 * Menu callbacks — `back_to_menu` + `check_channel`.
 *
 * Both rebuild the main keyboard via the bot/widgets/main-keyboard
 * widget and reply with `menu.choose_action` / `channel.verified`.
 *
 * `check_channel` additionally probes channel membership via the
 * Telegram Bot API; when the user is not a member the keyboard reply
 * is suppressed and the user gets `channel.not_subscribed`. Membership
 * check failures fall through (let the user in) — Telegram occasionally
 * 502s on getChatMember and we don't want a transient outage to lock
 * legitimate users out of the bot.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';
import { buildMainKeyboard } from '../widgets/main-keyboard.js';

import type { PageRegistrar } from './types.js';

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

interface ChannelPolicyShape {
  readonly channelRequired?: boolean;
  readonly channelLink?: string;
  readonly channelId?: string | number;
}

export const registerMenuPage: PageRegistrar = (bot, deps) => {
  bot.callbackQuery('back_to_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgUser = ctx.from;
    if (tgUser === undefined) return;
    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));

    const botCfg = await deps.getConfig();
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
    await ctx.reply(deps.translator.t('menu.choose_action', lang), {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery('check_channel', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgUser = ctx.from;
    if (tgUser === undefined) return;
    const lang = coerceLocale(deps.userLocale.getSync(tgUser.id));

    try {
      const policy = deps.adminClient
        ? ((await deps.adminClient.system.getPlatformPolicy()) as ChannelPolicyShape | null)
        : null;
      if (policy?.channelRequired === true && typeof policy.channelLink === 'string' && policy.channelLink.length > 0) {
        const channelId = policy.channelId ?? policy.channelLink;
        const member = await ctx.api.getChatMember(channelId, tgUser.id);
        if (member.status === 'left' || member.status === 'kicked') {
          await ctx.reply(deps.translator.t('channel.not_subscribed', lang));
          return;
        }
      }
    } catch {
      // Can't verify — let them through. Telegram getChatMember occasionally
      // 502s; locking the user out on a transient probe is the wrong call.
    }

    // Channel check passed — show main menu.
    const botCfg = await deps.getConfig();
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
    await ctx.reply(deps.translator.t('channel.verified', lang), {
      reply_markup: keyboard,
    });
  });
};
