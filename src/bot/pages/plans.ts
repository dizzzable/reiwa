/**
 * Plans page — `/plans` command.
 *
 * Lists the operator-managed plan catalog as a single rendered
 * message. Empty catalog → `plans.empty`; admin failure → `plans.error`.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';
import { buildPlansMessage } from '../../infrastructure/bot-message/message-builder.js';
import type { Plan } from '../../infrastructure/bot-config/types.js';

import { replyWithEntities } from './reply.js';
import type { PageRegistrar } from './types.js';

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

export const registerPlansPage: PageRegistrar = (bot, deps) => {
  bot.command('plans', async (ctx) => {
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await deps.getConfig();

    try {
      const plans = deps.adminClient
        ? ((await deps.adminClient.catalog
            .getPublicPlans()
            .catch(() => [])) as Plan[])
        : [];
      if (plans.length === 0) {
        await ctx.reply(deps.translator.t('plans.empty', lang));
        return;
      }
      const message = buildPlansMessage({ plans, botEmojis: botCfg.botEmojis });
      await replyWithEntities(ctx, message);
    } catch {
      await ctx.reply(deps.translator.t('plans.error', lang));
    }
  });
};
