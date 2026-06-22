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
import { renderBotCopy, renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import {
  buildScreenKeyboard,
  findScreenByShortId,
  pickScreenText,
} from './screen-renderer.js';
import { renderScreenWithBanner, resolveScreenBannerRef } from './screen-banner.js';
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
    const backButton = renderSystemButton(backLabel, 'back', config);

    if (screen === null) {
      logger?.warn(
        { shortId, screensCount: config.screens?.length ?? 0 },
        'dynamic-screen: shortId not found in config',
      );
      const kb = new InlineKeyboard();
      if (backButton.iconCustomEmojiId !== undefined) {
        kb.text({ text: backButton.text, icon_custom_emoji_id: backButton.iconCustomEmojiId }, 'menu:main');
      } else {
        kb.text(backButton.text, 'menu:main');
      }
      await editOrReply(ctx, {
        text: translator.t('screen.not_found', lang),
        replyMarkup: kb,
      });
      return;
    }

    const text = pickScreenText(screen, lang);
    // `{{KEY}}` placeholders → premium custom-emoji (operator-managed via the
    // "Эмодзи" editor). Telegram falls back to the unicode glyph for bots
    // without the capability, so this never breaks delivery.
    const renderedText = renderBotCopy(text, config.botEmojis, config.customEmojis, config.botEmojiOwnerHasPremium);
    const keyboard = buildScreenKeyboard(
      screen,
      lang,
      urls.publicWebUrl,
      urls.miniAppUrl,
      {
        botEmojis: config.botEmojis,
        customEmojis: config.customEmojis,
        ownerHasPremium: config.botEmojiOwnerHasPremium,
      },
    );
    // Operators who don't configure their own back button should
    // still get one for free — drop a `[◀️ В меню]` row at the bottom
    // when the screen has zero rows configured.
    if (screen.buttons.length === 0) {
      if (backButton.iconCustomEmojiId !== undefined) {
        keyboard.text({ text: backButton.text, icon_custom_emoji_id: backButton.iconCustomEmojiId }, 'menu:main');
      } else {
        keyboard.text(backButton.text, 'menu:main');
      }
    }

    try {
      // Render the screen's banner (own photo media, or the global banner
      // when "one banner for all screens" is on) as a real photo. Falls
      // back to the in-place text edit when no banner is desired or it
      // can't be resolved.
      const bannerRef = resolveScreenBannerRef(screen, config.visual);
      const bannerHandled = await renderScreenWithBanner(
        ctx,
        {
          text: renderedText.text,
          entities: renderedText.entities,
          replyMarkup: keyboard,
          bannerRef,
        },
        {
          rezeisAdminUrl: urls.rezeisAdminUrl,
          logger: logger
            ? {
                warn: (obj, msg) => {
                  logger.warn(obj as Record<string, unknown>, msg);
                },
              }
            : undefined,
        },
      );
      if (!bannerHandled) {
        await editOrReply(ctx, {
          text: renderedText.text,
          entities: renderedText.entities,
          replyMarkup: keyboard,
        });
      }
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
