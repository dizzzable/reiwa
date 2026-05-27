/**
 * Profile page — `/profile` command + `profile` callback.
 *
 * Renders the user's session card from
 * `AdminClient.user.getSession(telegramId)` and pins a 3-button
 * inline keyboard (RU / EN switcher + Back to menu).
 */
import { InlineKeyboard } from 'grammy';

import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';

import type { PageRegistrar } from './types.js';

interface UserSessionShape {
  readonly name?: string;
  readonly username?: string;
  readonly language?: string;
  readonly points?: number;
  readonly personalDiscount?: number;
  readonly referralCode?: string;
  readonly hasSubscription?: boolean;
}

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

async function renderProfile(
  ctx: { from?: { id: number }; reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown> },
  deps: Parameters<PageRegistrar>[1],
): Promise<void> {
  const telegramId = String(ctx.from?.id ?? '');
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));

  try {
    const session = deps.adminClient
      ? ((await deps.adminClient.user
          .getSession(telegramId)
          .catch(() => null)) as UserSessionShape | null)
      : null;

    if (session === null) {
      await ctx.reply(deps.translator.t('error_generic', lang));
      return;
    }

    const lines = [
      `👤 ${deps.translator.t('profile.header', lang)}\n`,
      deps.translator.t('profile.name', lang, { name: session.name ?? '—' }),
    ];
    if (session.username !== undefined && session.username.length > 0) {
      lines.push(deps.translator.t('profile.username', lang, { username: session.username }));
    }
    lines.push(
      deps.translator.t('profile.language', lang, {
        lang: (session.language ?? 'RU').toUpperCase(),
      }),
    );
    lines.push(deps.translator.t('profile.points', lang, { points: session.points ?? 0 }));
    if ((session.personalDiscount ?? 0) > 0) {
      lines.push(
        deps.translator.t('profile.discount', lang, {
          discount: session.personalDiscount ?? 0,
        }),
      );
    }
    lines.push(deps.translator.t('profile.referral_code', lang, { code: session.referralCode ?? '—' }));
    lines.push(
      session.hasSubscription === true
        ? deps.translator.t('profile.has_subscription', lang)
        : deps.translator.t('profile.no_subscription', lang),
    );

    const kb = new InlineKeyboard()
      .text(deps.translator.t('lang.ru', lang), 'lang:ru')
      .text(deps.translator.t('lang.en', lang), 'lang:en')
      .row()
      .text(deps.translator.t('back_to_menu', lang), 'back_to_menu');

    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  } catch {
    await ctx.reply(deps.translator.t('error_generic', lang));
  }
}

export const registerProfilePage: PageRegistrar = (bot, deps) => {
  bot.command('profile', async (ctx) => {
    await renderProfile(ctx, deps);
  });

  bot.callbackQuery('profile', async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderProfile(ctx, deps);
  });
};
