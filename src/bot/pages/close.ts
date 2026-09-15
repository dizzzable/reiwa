/**
 * `close` callback — a universal "❌ Закрыть" button handler that deletes the
 * message it's attached to. Reused by the bot-started operator notice and any
 * other dismissable card (snoups/remnashop-style close behaviour).
 */
import type { PageRegistrar } from './types.js';

/**
 * Exported for the channel gate middleware, which lets it through unchecked.
 * The cards carrying it go to `BOT_DEV_ID`'s private chat (startup notice,
 * credits, `/notify-dev`), and the handler does nothing but delete the message
 * it sits on — refusing it would only lock an operator who is not in the
 * gate's channel out of dismissing their own cards.
 */
export const CLOSE_CALLBACK = 'close';

export const registerClosePage: PageRegistrar = (bot, _deps) => {
  bot.callbackQuery(CLOSE_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
  });
};
