/**
 * Subscription page — `/subscription` command + `subscription` callback.
 *
 * Both surfaces render the same subscription card (built from the
 * AdminClient `getActive` namespace call + the bot config emoji map).
 * When no active subscription exists, the user gets `subscription.no_active`
 * inviting them to use `/plans`.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';
import { buildSubscriptionCard } from '../../infrastructure/bot-message/message-builder.js';
import type { Subscription } from '../../infrastructure/bot-config/types.js';

import type { PageRegistrar } from './types.js';
import { replyWithEntities } from './reply.js';

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

async function renderSubscription(
  ctx: { from?: { id: number }; reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown> },
  deps: Parameters<PageRegistrar>[1],
): Promise<void> {
  const telegramId = String(ctx.from?.id ?? '');
  const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
  const botCfg = await deps.getConfig();

  try {
    const sub = deps.adminClient
      ? ((await deps.adminClient.subscription
          .getActive(telegramId)
          .catch(() => null)) as Subscription | null)
      : null;
    if (sub === null) {
      await ctx.reply(deps.translator.t('subscription.no_active', lang));
      return;
    }
    const message = buildSubscriptionCard({ subscription: sub, botEmojis: botCfg.botEmojis });
    await replyWithEntities(ctx, message);
  } catch {
    await ctx.reply(deps.translator.t('subscription.error', lang));
  }
}

export const registerSubscriptionPage: PageRegistrar = (bot, deps) => {
  bot.command('subscription', async (ctx) => {
    await renderSubscription(ctx, deps);
  });

  bot.callbackQuery('subscription', async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderSubscription(ctx, deps);
  });
};
