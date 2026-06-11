/**
 * `close` callback — a universal "❌ Закрыть" button handler that deletes the
 * message it's attached to. Reused by the bot-started operator notice and any
 * other dismissable card (snoups/remnashop-style close behaviour).
 */
import type { PageRegistrar } from './types.js';

export const registerClosePage: PageRegistrar = (bot, _deps) => {
  bot.callbackQuery('close', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
  });
};
