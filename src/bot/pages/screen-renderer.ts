/**
 * Universal screen renderer.
 *
 * STEALTHNET-style dynamic screens: the admin panel's BotFlow graph
 * defines a tree of screens, each with its own copy + inline keyboard.
 * When the user presses a reply-button OR an inline button whose
 * action targets a screen, reiwa renders that screen *in place* via
 * `editOrReply`, mirroring the built-in sub-menus we already have for
 * help / rules / invite.
 *
 * Resolution order when a callback `screen:<shortId>` is received:
 *   1. Look up the screen in `BotConfig.screens` by shortId. Empty
 *      array (no published flow) → built-in fallback handlers in
 *      help-callback/rules/invite take over the named callbacks
 *      (`help`/`rules`/`invite`).
 *   2. Render the screen's `text<Locale>` + inline-keyboard built
 *      from `screen.buttons`.
 *   3. If any button has `action: 'navigate'`, its callback_data
 *      becomes `screen:<targetShortId>` so the user can drill
 *      deeper. `back` returns to `menu:main` (welcome screen) by
 *      convention; richer history would need session state.
 */
import { InlineKeyboard } from 'grammy';

import type { BotScreen, BotScreenButton } from '../../infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';

/**
 * Pick the locale-appropriate text from a screen. Falls back to the
 * RU copy when EN is empty (admin operators occasionally leave EN
 * unfilled — never blow up because of it).
 */
export function pickScreenText(screen: BotScreen, lang: SupportedLocale): string {
  if (lang === 'en' && screen.textEn.trim().length > 0) return screen.textEn;
  return screen.textRu;
}

/**
 * Substitute `{{placeholders}}` in the screen's text with runtime
 * values supplied by the caller. Used by built-in handlers (invite,
 * rules, help) so an operator can edit the copy in Bot Studio while
 * the bot still injects per-user tokens like the referral link or
 * support handle.
 *
 * Supported placeholders are documented in
 * `botFlow.fields.textRuPlaceholderHint` on the SPA side. Anything
 * else passes through unchanged so operator-driven custom screens
 * with their own placeholder syntax aren't accidentally mangled.
 */
export function applyScreenTemplate(
  screen: BotScreen,
  lang: SupportedLocale,
  vars: Readonly<Record<string, string>>,
): string {
  let text = pickScreenText(screen, lang);
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    text = text.replace(placeholder, value);
  }
  return text;
}

/**
 * Append a `[◀️ В меню]` row to an inline keyboard. The page
 * convention is that every sub-screen has a back button on its
 * trailing row — operators don't have to wire it for every screen
 * they design, and the universal screen renderer adds it
 * automatically when the operator hasn't already.
 */
export function appendBackToMenuRow(
  kb: InlineKeyboard,
  backLabel: string,
): InlineKeyboard {
  return kb.row().text(backLabel, 'menu:main');
}

export function pickButtonLabel(
  button: BotScreenButton,
  lang: SupportedLocale,
): string {
  if (lang === 'en' && button.labelEn.trim().length > 0) return button.labelEn;
  return button.labelRu;
}

/**
 * Build a grammy `InlineKeyboard` from a screen's button list. Buttons
 * are placed onto rows by their `row` index; ties broken by `col`.
 *
 * Each action maps onto one of grammy's native button kinds:
 *   - `navigate`   → `kb.text(label, "screen:<targetShortId>")`
 *   - `back`       → `kb.text(label, "menu:main")` (welcome screen)
 *   - `start_over` → `kb.text(label, "menu:main")` (alias for `back`
 *                     today; future iterations may push the user back
 *                     to a per-flow root instead of the global welcome)
 *   - `callback`   → `kb.text(label, callbackAction)` with the raw
 *                     callback id (must match a registered handler;
 *                     unknown ids no-op silently in grammy)
 *   - `url`        → `kb.url(label, url)` — non-HTTPS / localhost
 *                     URLs are dropped silently (Telegram refuses)
 *   - `webapp`     → `kb.webApp(label, webAppUrl)` — same HTTPS gate
 *
 * `style` and `iconCustomEmojiId` are forwarded via grammy's
 * object-form `kb.text({...}, data)` API — Bot API 9.4+ owners with
 * Premium see colored buttons + custom-emoji icons; non-Premium
 * owners get the plain label silently.
 */
export function buildScreenKeyboard(
  screen: BotScreen,
  lang: SupportedLocale,
  publicWebUrl: string | null,
  miniAppUrl: string | null,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const sorted = [...screen.buttons].sort(
    (a, b) => a.row - b.row || a.col - b.col,
  );
  let currentRow = -1;
  for (const btn of sorted) {
    const label = pickButtonLabel(btn, lang);
    if (btn.row !== currentRow) {
      if (currentRow !== -1) kb.row();
      currentRow = btn.row;
    }
    const styleValue = mapStyle(btn.style);
    const iconValue =
      btn.iconCustomEmojiId !== null && btn.iconCustomEmojiId.length > 0
        ? btn.iconCustomEmojiId
        : undefined;
    const buttonExtras: {
      icon_custom_emoji_id?: string;
      style?: 'danger' | 'success' | 'primary';
    } = {};
    if (iconValue !== undefined) buttonExtras.icon_custom_emoji_id = iconValue;
    if (styleValue !== undefined) buttonExtras.style = styleValue;

    switch (btn.action) {
      case 'navigate':
        if (btn.targetShortId !== null && btn.targetShortId.length > 0) {
          kb.text({ text: label, ...buttonExtras }, `screen:${btn.targetShortId}`);
        }
        break;
      case 'back':
      case 'start_over':
        kb.text({ text: label, ...buttonExtras }, 'menu:main');
        break;
      case 'callback':
        if (btn.callbackAction !== null && btn.callbackAction.length > 0) {
          kb.text({ text: label, ...buttonExtras }, btn.callbackAction);
        }
        break;
      case 'url': {
        // Empty / non-HTTPS / localhost URLs would 400 the call.
        // Dropping the button silently is preferable to a broken row.
        const url = (btn.url ?? '').trim();
        if (url.length > 0 && isTelegramSafeButtonUrl(url)) {
          kb.url({ text: label, ...buttonExtras }, url);
        } else if (
          url.length > 0 &&
          publicWebUrl !== null &&
          (url.startsWith('/') || !url.includes('://'))
        ) {
          // Relative path — anchor it on the operator-configured public
          // URL so the admin doesn't have to hardcode the domain in
          // every button. Same Telegram-safety rule applies post-anchor.
          const anchored = `${publicWebUrl}${url.startsWith('/') ? '' : '/'}${url}`;
          if (isTelegramSafeButtonUrl(anchored)) {
            kb.url({ text: label, ...buttonExtras }, anchored);
          }
        }
        break;
      }
      case 'webapp': {
        const url = (btn.webAppUrl ?? '').trim();
        if (url.length > 0 && isTelegramSafeButtonUrl(url)) {
          kb.webApp({ text: label, ...buttonExtras }, url);
        } else if (
          url.length > 0 &&
          miniAppUrl !== null &&
          (url.startsWith('/') || !url.includes('://'))
        ) {
          const anchored = `${miniAppUrl}${url.startsWith('/') ? '' : '/'}${url}`;
          if (isTelegramSafeButtonUrl(anchored)) {
            kb.webApp({ text: label, ...buttonExtras }, anchored);
          }
        }
        break;
      }
    }
  }
  return kb;
}

function mapStyle(
  style: BotScreenButton['style'],
): 'danger' | 'success' | 'primary' | undefined {
  switch (style) {
    case 'primary':
      return 'primary';
    case 'success':
      return 'success';
    case 'danger':
      return 'danger';
    default:
      return undefined;
  }
}

/**
 * Find a screen in the published flow by its `shortId`. Returns
 * `null` when the flow is empty / the id is unknown — callers
 * (universal `screen:*` handler) should fall back to built-ins or a
 * "screen not found" reply with a back-to-menu button.
 */
export function findScreenByShortId(
  screens: readonly BotScreen[] | undefined,
  shortId: string,
): BotScreen | null {
  if (screens === undefined) return null;
  return screens.find((s) => s.shortId === shortId) ?? null;
}

/**
 * Find a screen by callback name (used to override built-in
 * sub-menus like `help` / `rules` / `invite`). The `name` field on
 * the admin side doubles as the override key — operators set it to
 * the callback id they want to take over.
 */
export function findScreenByName(
  screens: readonly BotScreen[] | undefined,
  name: string,
): BotScreen | null {
  if (screens === undefined) return null;
  const lower = name.toLowerCase();
  return screens.find((s) => s.name.toLowerCase() === lower) ?? null;
}
