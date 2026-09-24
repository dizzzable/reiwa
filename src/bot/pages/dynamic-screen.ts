/**
 * Dynamic screen page — handles every callback `screen:<shortId>`, and a
 * callback whose whole data is the shortId of a screen that exists.
 *
 * Sister to start.ts / help-callback / rules / invite. Where those
 * have hardcoded copy, this one reads from `BotConfig.screens` and
 * renders whatever the operator configured in Bot Studio. Resolution:
 *
 *   1. Strip the `screen:` prefix off the callback data (a bare shortId has
 *      none, and is taken only when nothing else claims the data — see
 *      where it is registered).
 *   2. Look up the screen in `BotConfig.screens` by shortId. A screen named
 *      help / rules / invite goes to its built-in handler (`BUILT_IN_SCREENS`).
 *   3. Render the screen's text + inline keyboard via `editOrReply`.
 *   4. On miss — a `screen:<shortId>` button on an old message, onto a screen
 *      the operator has since deleted or the published flow no longer has —
 *      the current main menu in place of that message, with the «Меню
 *      обновилось» toast (`answerStaleButton`; owner's decision, 24.09.2026). It
 *      used to say «экран не найден» there, with a way back to the menu. A bare
 *      shortId that names no screen goes on to the stale-button page, which
 *      answers the same.
 */
import { coerceLocale } from './coerce-locale.js';
import { renderBotCopy, renderBotCopyHtml, renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import { configWithin } from '../lib/config-within.js';
import {
  buildScreenKeyboard,
  findScreenByShortId,
  pickScreenText,
} from './screen-renderer.js';
import { renderScreenOrEdit } from './screen-banner.js';
import { resolveConfiguredSupportUrl, supportPrefill } from '../widgets/main-keyboard.js';
import { showHelpScreen } from './help-callback.js';
import { showInviteScreen } from './invite.js';
import { showRulesScreen } from './rules.js';
import { answerStaleButton } from './stale-button.js';
import type { BotConfig, BotScreen } from '../../infrastructure/bot-config/types.js';
import type { BotContext, PageDeps, PageRegistrar } from './types.js';

const SCREEN_PREFIX = 'screen:';

/**
 * How long a callback nothing else claimed waits for the config that says
 * whether its data is a screen's shortId. Most such data is dead buttons — an
 * old message's, a menu id no page answers — and before bare shortIds were
 * taken nothing waited on them at all. A cache hit comes back at once; only a
 * refresh from a slow or hung panel runs into this, and then the config the
 * bot holds decides (`lib/config-within.ts`). Updates are handled one at a time:
 * every millisecond here is one for each update queued behind.
 */
const SHORT_ID_LOOKUP_BUDGET_MS = 250;

/**
 * The screens with a built-in handler, by the name the operator's screen takes
 * them over with (matched as `findScreenByName` matches it, case aside). A
 * `screen:<shortId>` button reaches them too — a NAVIGATE edge onto one in
 * «Карта бота», a main-menu button set to «Экран бота», a notification button —
 * and is handed to the handler, which reads the same operator screen by name —
 * from the config the screen was found in: one config read per press, as
 * before the hand-off, and none at all where the bare-shortId handler decided
 * on the config at hand. A Map, not an object: a screen named `constructor`
 * must not find one.
 */
const BUILT_IN_SCREENS: ReadonlyMap<
  string,
  (ctx: BotContext, deps: PageDeps, found: BotConfig) => Promise<void>
> = new Map([
  ['help', showHelpScreen],
  ['rules', showRulesScreen],
  ['invite', showInviteScreen],
]);

export const registerDynamicScreenPage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, getConfig, urls, logger } = deps;

  /**
   * The operator's screen, found in `config`, on the pressed message. Both
   * callers below answer the callback query first, once; nothing in here
   * answers it.
   */
  const openScreen = async (ctx: BotContext, screen: BotScreen, config: BotConfig): Promise<void> => {
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const backLabel = translator.t('back_to_menu', lang);
    const backButton = renderSystemButton(backLabel, 'back', config);
    const shortId = screen.shortId;

    // A built-in screen reached by its shortId is still that screen: its own
    // handler fills its placeholders in and adds its system buttons, which a
    // plain render did not — `{{rulesLink}}` went out raw, with no way to open
    // the rules.
    const builtIn = BUILT_IN_SCREENS.get(screen.name.toLowerCase());
    if (builtIn !== undefined) {
      try {
        await builtIn(ctx, deps, config);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('message is not modified')) throw err;
      }
      return;
    }

    const text = pickScreenText(screen, lang);
    // Operator-chosen format: HTML screens render the markup as Telegram HTML
    // (premium emoji via <tg-emoji> tags) and send with parse_mode HTML; other
    // screens keep the entity-based render (premium emoji via entities).
    const useHtml = screen.parseMode === 'html';
    const renderedText = useHtml
      ? {
          text: renderBotCopyHtml(text, config.botEmojis, config.customEmojis, config.botEmojiOwnerHasPremium),
          entities: undefined,
        }
      : renderBotCopy(text, config.botEmojis, config.customEmojis, config.botEmojiOwnerHasPremium);
    const parseMode = useHtml ? ('HTML' as const) : undefined;
    const keyboard = buildScreenKeyboard(
      screen,
      lang,
      urls.publicWebUrl,
      urls.miniAppUrl,
      {
        botEmojis: config.botEmojis,
        customEmojis: config.customEmojis,
        ownerHasPremium: config.botEmojiOwnerHasPremium,
        supportUrl: resolveConfiguredSupportUrl(
          config.visual.supportUsername,
          deps.envSupportUsername,
          supportPrefill(translator, lang, config),
        ),
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
      // when "one banner for all screens" is on) as a real photo — and when
      // this screen has NO banner but the live message still carries another
      // screen's banner, delete + resend as text so it never lingers. Shared
      // with the named-override screens and menu:main via `renderViewWithBanner`.
      await renderScreenOrEdit(ctx, deps, config.visual, {
        overrideScreen: screen,
        text: renderedText.text,
        entities: renderedText.entities,
        parseMode,
        replyMarkup: keyboard,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        logger?.warn(
          { err, shortId, telegramId: ctx.from?.id },
          'dynamic-screen: edit failed',
        );
      }
    }
  };

  bot.callbackQuery(new RegExp(`^${SCREEN_PREFIX}.+$`), async (ctx) => {
    const shortId = (ctx.callbackQuery?.data ?? '').slice(SCREEN_PREFIX.length);
    const config = await getConfig();
    const screen = findScreenByShortId(config.screens, shortId);
    if (screen === null) {
      // The operator deleted the screen, or the published flow no longer has
      // it: a button on an old message. The current menu in its place, with
      // «Меню обновилось» — not an error (owner's decision, 24.09.2026).
      logger?.info(
        { shortId, screensCount: config.screens?.length ?? 0 },
        'dynamic-screen: a button onto a screen the flow no longer has; showing the current menu',
      );
      await answerStaleButton(ctx, deps);
      return;
    }
    await ctx.answerCallbackQuery();
    await openScreen(ctx, screen, config);
  });

  // A bare shortId — the whole callback data, no `screen:` — is that screen
  // too. The panel's notification editor takes a button's callback data as free
  // text, and «Карта бота» has drawn a bare shortId as a way to its screen
  // since June, while nothing here answered one and such a button only spun.
  //
  // It sees only data NOTHING else claims: this page is registered after every
  // other page but the stale-button one (`main.ts`), and a handler above that
  // matches the data ends the chain. So a screen whose shortId is spelled like a
  // known callback — `help`, `menu` — cannot take that callback over. Data that
  // names no screen is passed on, to the stale-button answer
  // (`pages/stale-button.ts`).
  //
  // The config at hand decides, within SHORT_ID_LOOKUP_BUDGET_MS — past it, the
  // config the bot holds: a stale one tells a shortId as well as a fresh one,
  // and with none at all the data is passed on. The screen is opened from the
  // config it was found in.
  bot.on('callback_query:data', async (ctx, next) => {
    const config = await configWithin(deps, SHORT_ID_LOOKUP_BUDGET_MS);
    const screen = config === null ? null : findScreenByShortId(config.screens, ctx.callbackQuery.data);
    if (config === null || screen === null) return next();
    await ctx.answerCallbackQuery();
    await openScreen(ctx, screen, config);
  });
};
