/**
 * Activity callback page — renders the user's recent transactions as a
 * plain bullet list. Empty list ⇒ `activity.empty`; admin failure ⇒
 * `activity.error`.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../core/enums/locale.enum.js';

import type { PageRegistrar } from './types.js';

interface TransactionShape {
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly status?: unknown;
  readonly gatewayType?: unknown;
  readonly gateway?: unknown;
  readonly pricing?: { readonly finalPrice?: unknown; readonly currency?: unknown };
}

interface TransactionsResultShape {
  readonly transactions?: TransactionShape[];
  readonly items?: TransactionShape[];
}

function coerceLocale(lang: string): SupportedLocale {
  const lower = lang.toLowerCase();
  return isSupportedLocale(lower) ? lower : DEFAULT_LOCALE;
}

function renderLine(tx: TransactionShape): string {
  const pricing = tx.pricing ?? {};
  const amount = pricing.finalPrice ?? tx.amount ?? '—';
  const currency = pricing.currency ?? tx.currency ?? '';
  const status = String(tx.status ?? '');
  const gw = String(tx.gatewayType ?? tx.gateway ?? '');
  return `• ${gw} — ${String(amount)} ${String(currency)} — ${status}`;
}

export const registerActivityPage: PageRegistrar = (bot, deps) => {
  bot.callbackQuery('activity', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));

    try {
      const result = deps.adminClient
        ? ((await deps.adminClient.activity
            .getTransactions(telegramId)
            .catch(() => null)) as TransactionsResultShape | null)
        : null;

      const txs = result?.transactions ?? result?.items ?? [];

      if (txs.length === 0) {
        await ctx.reply(deps.translator.t('activity.empty', lang));
        return;
      }

      const header = deps.translator.t('activity.header', lang);
      const body = txs.map(renderLine).join('\n');
      await ctx.reply(`${header}\n\n${body}`);
    } catch {
      await ctx.reply(deps.translator.t('activity.error', lang));
    }
  });
};
