/**
 * Dynamic screen page — handles every callback `screen:<shortId>`.
 *
 * Sister to start.ts / help-callback / rules / invite. Where those
 * have hardcoded copy, this one reads from `BotConfig.screens` and
 * renders whatever the operator configured in Bot Studio. Resolution:
 *
 *   1. Strip the `screen:` prefix off the callback data.
 *   2. Look up the screen in `BotConfig.screens` by shortId.
 *   3. Render the screen's text + inline keyboard via `editOrReply`.
 *   4. On miss (operator deleted the screen between cache refresh and
 *      callback delivery, or screensVersion changed), reply with a
 *      "screen not found" message + back-to-menu button so the user
 *      doesn't get stuck.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import {
  buildScreenKeyboard,
  findScreenByShortId,
  pickScreenText,
} from './screen-renderer.js';
import type { PageRegistrar } from './types.js';

const SCREEN_PREFIX = 'screen:';

export const registerDynamicScreenPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, getConfig, urls, logger } = deps;

  bot.callbackQuery(new RegExp(`^${SCREEN_PREFIX}.+$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery?.data ?? '';
    const shortId = data.slice(SCREEN_PREFIX.length);
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const backLabel = translator.t('back_to_menu', lang);

    const config = await getConfig();
    const screen = findScreenByShortId(config.screens, shortId);

    if (screen === null) {
      logger?.warn(
        { shortId, screensCount: config.screens?.length ?? 0 },
        'dynamic-screen: shortId not found in config',
      );
      const kb = new InlineKeyboard().text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('screen.not_found', lang),
        replyMarkup: kb,
      });
      return;
    }

    const text = pickScreenText(screen, lang);
    const keyboard = buildScreenKeyboard(
      screen,
      lang,
      urls.publicWebUrl,
      urls.miniAppUrl,
    );
    // Operators who don't configure their own back button should
    // still get one for free — drop a `[◀️ В меню]` row at the bottom
    // when the screen has zero rows configured.
    if (screen.buttons.length === 0) {
      keyboard.text(backLabel, 'menu:main');
    }

    try {
      await editOrReply(ctx, { text, replyMarkup: keyboard });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        logger?.warn(
          { err, shortId, telegramId: ctx.from?.id },
          'dynamic-screen: edit failed',
        );
      }
    }
  });
};
