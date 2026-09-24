/**
 * A button the bot no longer knows — «Меню обновилось».
 *
 * An old message keeps the buttons it was sent with. When the operator removes
 * a button, deletes a screen or changes what a button sends, the old message
 * still carries the old callback data, and a press on it used to reach no
 * handler at all: nothing answered the callback query, the button spun until
 * Telegram gave up, and the user saw silence (W8 report §7.3). The owner's
 * decision (24.09.2026): such a press shows the current menu, not an error —
 * the toast «Меню обновилось» (`menu.updated`, editable in the panel), and the
 * main menu drawn in place of THAT message (`showMainMenu`: or sent anew when
 * Telegram will not edit it). The same answer as a `screen:<shortId>` button
 * onto a screen the flow no longer has (`dynamic-screen.ts`).
 *
 * What it does not do:
 *  - retarget an old button to where the operator moved it — deferred by the
 *    owner; the data is gone, and so is what it meant;
 *  - rewrite any other message: only the one pressed, which the user is
 *    looking at. Telegram allows a bot about thirty messages a second, and old
 *    menus in thousands of chats are not worth them;
 *  - open a way past a gate. The channel gate's middleware stands in front of
 *    every page, so a press it stops never gets here; `showMainMenu` keeps the
 *    own-chat rule and the RESTRICTED alert of «В меню»; and a press the gate
 *    lets through unchecked — a business chat, a message with no chat — is only
 *    answered here, with nothing drawn (`channelGateScope` 'pass').
 *
 * It must see only data NOTHING else claims, so it is the very last handler
 * `main.ts` registers, after the dynamic screens' bare-shortId handler — pinned
 * by `test/bot/callback-routing.test.ts`. Callback data only: a game's button
 * carries none, and this bot has no games.
 */
import { channelGateScope } from '../middleware/channel-gate.js';
import { showMainMenu } from './start.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';

/** The toast a button the bot no longer knows is answered with. */
export const STALE_BUTTON_NOTICE_KEY = 'menu.updated';

/**
 * The answer to a button the bot no longer knows: «Меню обновилось» and the
 * current main menu in place of its message. Shared with `dynamic-screen.ts`,
 * whose `screen:<shortId>` onto a screen that is gone gets the same.
 */
export async function answerStaleButton(ctx: BotContext, deps: PageDeps): Promise<void> {
  // Outside the user's own chat, and wherever the channel gate did not look:
  // stop the spinner, draw nothing.
  if (channelGateScope(ctx) === 'pass') {
    await ctx.answerCallbackQuery();
    return;
  }
  await showMainMenu(ctx, deps, { noticeKey: STALE_BUTTON_NOTICE_KEY });
}

export const registerStaleButtonPage: PageRegistrar = (bot, deps) => {
  bot.on('callback_query:data', async (ctx) => {
    deps.logger?.info(
      { data: ctx.callbackQuery.data, telegramId: ctx.from?.id },
      'stale-button: a button no handler knows; showing the current menu',
    );
    await answerStaleButton(ctx, deps);
  });
};
