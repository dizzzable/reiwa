/**
 * Main reply keyboard builder.
 *
 * Composes a grammy `InlineKeyboard` from the operator-managed bot
 * config plus the resolved per-button URL/Mini-App routes. Pure logic,
 * no network or grammy lifecycle coupling — easy to unit-test.
 *
 * Four button kinds:
 *   - `url`         — opens an external HTTPS URL in Telegram's in-app
 *                     browser. Built from `publicWebUrl + binding.path`.
 *                     Drops the button silently when no safe URL exists
 *                     (dev where `publicWebUrl` is `null`).
 *   - `webapp`      — opens the Mini App. Telegram requires HTTPS; we
 *                     drop the button when `miniAppUrl` is `null`.
 *   - `support_url` — opens a `t.me/<handle>?text=<prefill>` deep-link
 *                     directly. No intermediate sub-screen — one tap
 *                     and the user is in the support DM with a
 *                     pre-filled greeting (snoups-style UX). Falls
 *                     back to the `callback` kind silently when the
 *                     handle is numeric or unset.
 *   - `callback`    — emits `callback_data === buttonId`; routed by
 *                     reiwa's `bot.callbackQuery(id, ...)` handlers.
 *
 * The admin panel only manages visual properties (label, style,
 * visibility, ordering, single-row flag). The `kind` per well-known
 * `buttonId` is hardcoded in `BUTTON_KIND_MAP` so admin operators
 * can't accidentally turn "Мой кабинет" into a callback that
 * doesn't exist or vice-versa. Unknown ids default to `callback`.
 */
import { InlineKeyboard } from 'grammy';

import type { BotMenuButton } from '../../infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

export type ButtonKind = 'url' | 'webapp' | 'callback' | 'support_url';

export interface ButtonBinding {
  readonly kind: ButtonKind;
  readonly path?: string;
}

/**
 * Telegram refuses inline-keyboard URLs that point at `localhost` /
 * `127.0.0.1` AND `web_app` URLs that aren't HTTPS. Both checks funnel
 * through this gate so dev (where `REIWA_DOMAIN=localhost:5173`
 * resolves to `http://localhost:5173`) doesn't crash the entire reply
 * with `400 Bad Request`. In production the operator types a real
 * domain and this becomes identical to `reiwaPublicUrl`.
 */
export function isTelegramSafeButtonUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('://localhost') || lower.includes('://127.0.0.1')) return false;
  return true;
}

/**
 * Maps the admin-side BotButton style enum onto the Telegram
 * `style` field for KeyboardButton / InlineKeyboardButton (Bot API 9.4+).
 * `DEFAULT` is admin's "no override" marker — return `undefined` so
 * grammy omits the field and Telegram applies its app-specific default.
 */
function mapButtonStyle(
  style: BotMenuButton['style'],
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

export const BUTTON_KIND_MAP: Readonly<Record<string, ButtonBinding>> = {
  // Default reiwa keyboard
  cabinet: { kind: 'url', path: '/' },
  invite: { kind: 'callback' },
  rules: { kind: 'callback' },
  help: { kind: 'support_url' },
  // Legacy buttons that older deployments may still have configured
  subscription: { kind: 'callback' },
  buy: { kind: 'callback' },
  promo: { kind: 'callback' },
  referrals: { kind: 'callback' },
  profile: { kind: 'callback' },
  activity: { kind: 'callback' },
  vpn: { kind: 'webapp', path: '/subscribe' },
  miniapp: { kind: 'webapp', path: '/' },
  support: { kind: 'support_url' },
};

export function resolveBinding(buttonId: string): ButtonBinding {
  return BUTTON_KIND_MAP[buttonId] ?? { kind: 'callback' };
}

/**
 * Operator-driven routing override.
 *
 * Reply-keyboard buttons can now declare their action+target in admin
 * (BotButton.actionType / BotButton.actionTarget). When set, that
 * routing wins over the built-in BUTTON_KIND_MAP — operators get full
 * control without us hardcoding every possible id.
 *
 * The fallback chain is:
 *   1. BotMenuButton.actionType (operator override) — primary path
 *      for any button, reserved or not.
 *   2. BUTTON_KIND_MAP[buttonId] — built-in routing for the legacy
 *      reserved ids. Lets cabinet / vpn / etc. keep working without
 *      any admin change.
 *   3. `{ kind: 'callback' }` — last-resort default; reiwa's
 *      universal screen handler (`screen:<shortId>`) resolves it
 *      when the button id matches a screen, otherwise the press
 *      no-ops.
 *
 * Returns the resolved binding plus an explicit `target` field that
 * carries the operator-configured URL / WebApp URL / screen shortId
 * verbatim (or `null` for callback / support_url).
 */
export interface ResolvedBinding {
  readonly kind: ButtonKind;
  /**
   * For operator-defined `url` / `webapp` → absolute URL.
   * For `screen`                          → BotFlowScreen.shortId.
   * For built-in BUTTON_KIND_MAP path     → the optional `path` suffix.
   * For `callback` / `support_url`        → null (resolved at render).
   */
  readonly target: string | null;
}

export function resolveButtonBinding(button: BotMenuButton): ResolvedBinding {
  const operatorAction = button.actionType;
  const operatorTarget = button.actionTarget ?? null;
  if (operatorAction !== undefined) {
    if (operatorAction === 'callback') {
      return { kind: 'callback', target: null };
    }
    if (operatorAction === 'support_url') {
      return { kind: 'support_url', target: null };
    }
    if (operatorAction === 'url' || operatorAction === 'webapp') {
      return { kind: operatorAction, target: operatorTarget };
    }
    if (operatorAction === 'screen') {
      return { kind: 'callback', target: operatorTarget };
    }
  }
  // Fall back to the built-in map for legacy ids that haven't been
  // re-tagged in admin yet.
  const builtin = resolveBinding(button.id);
  return { kind: builtin.kind, target: builtin.path ?? null };
}

export interface MainKeyboardOptions {
  readonly buttons: readonly BotMenuButton[];
  readonly miniAppUrl: string | null | undefined;
  readonly publicWebUrl: string | null | undefined;
  readonly lang: SupportedLocale;
  readonly translator: TranslatorPort;
  /**
   * Resolved support deep-link target — `t.me/<handle>?text=<prefill>`.
   * `null` when the operator hasn't set a real `@username`
   * (numeric chat id or empty). Buttons whose binding kind is
   * `support_url` fall back to a `callback` rendering when this is
   * `null`, so the bot's `bot.callbackQuery('help', ...)` handler
   * still picks up the press and surfaces a useful sub-screen.
   */
  readonly supportUrl?: string | null;
  /**
   * One-time bot-signin token for URL-kind buttons. When set, the
   * URL gets a `?signin=<token>` query parameter so the SPA's
   * `WebHomePage` recognises the magic-link flow and authenticates
   * the user without sending them through `/sign-in`.
   *
   * `null` / `undefined` is the legacy path: the URL is opened raw,
   * SPA falls through to `/sign-in` if no cookie exists. This is the
   * fallback when the bot couldn't resolve the user (no admin client,
   * blocked user, network error issuing the token).
   *
   * Only `url` kind buttons get the token — `webapp` buttons go
   * through `Telegram.WebApp.initData` for auth, no token required;
   * `support_url` and `callback` don't take URLs at all.
   */
  readonly signinToken?: string | null;
  /** Optional primary trial button rendered at the top for eligible users. */
  readonly trialButton?: TrialButtonSpec | null;
}

/**
 * Optional primary "trial" button injected at the TOP of the keyboard for
 * subscription-less users (see `.kiro/specs/web-cabinet-onboarding`,
 * Property 5/6/10/11). Always rendered with `style: 'primary'`; carries the
 * premium `icon_custom_emoji_id` when configured (Bot API 9.4) and degrades to
 * a leading unicode glyph in `text` otherwise. Deep-links into the cabinet
 * (Mini App when available, else the magic-link URL) where the trial CTA lives.
 */
export interface TrialButtonSpec {
  /** Full button label; includes a leading unicode glyph when no premium icon. */
  readonly text: string;
  /** Premium custom-emoji id; when set, `text` should omit the unicode glyph. */
  readonly iconCustomEmojiId?: string | null;
  /** Magic-link cabinet URL (already `?signin=` stamped). Used for `url` kind. */
  readonly url?: string | null;
  /** Mini App URL — preferred target when Telegram-safe. */
  readonly miniAppUrl?: string | null;
}

const NUMERIC_HANDLE = /^-?\d+$/;

/**
 * Build the `t.me/<handle>?text=<prefill>` URL the support button
 * opens. Returns `null` when the handle is numeric (chat id, no
 * public username) or empty — Telegram's deep-link contract requires
 * a string handle, so numeric ids are unusable here. Both reply-
 * keyboard builders and the legacy callback handler share this
 * helper to stay in lockstep.
 */
export function resolveSupportDeepLink(
  handle: string | null | undefined,
  prefill: string | null | undefined,
): string | null {
  const cleaned = (handle ?? '').replace(/^@+/, '').trim();
  if (cleaned.length === 0 || NUMERIC_HANDLE.test(cleaned)) return null;
  const text = (prefill ?? '').trim();
  const query = text.length > 0 ? `?text=${encodeURIComponent(text)}` : '';
  return `https://t.me/${encodeURIComponent(cleaned)}${query}`;
}

/**
 * Append `?signin=<token>` to a URL in a way that's robust to URLs
 * that already carry query parameters (operator-configured
 * `actionTarget` e.g. `https://example.com/?utm_source=tg`).
 *
 * Returns the input unchanged when token is null/empty so the
 * tokenless fallback path is identical.
 */
export function attachSigninTokenToUrl(url: string, token: string | null | undefined): string {
  if (token === null || token === undefined || token.length === 0) return url;
  // Bail out cleanly on URLs we can't parse (unlikely but cheap to
  // protect against). The downstream Telegram check
  // `isTelegramSafeButtonUrl` will catch malformed URLs anyway.
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('signin', token);
    return parsed.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}signin=${encodeURIComponent(token)}`;
  }
}

/**
 * STEALTHNET-style keyboard builder. Walks visible buttons in order,
 * places each on its own row when `onePerRow=true` or pairs them when
 * `onePerRow=false` (max 2 per row).
 */
export function buildMainKeyboard(options: MainKeyboardOptions): InlineKeyboard {
  const { buttons, miniAppUrl, publicWebUrl, lang, translator, supportUrl, signinToken, trialButton } = options;
  const visible = [...buttons]
    .filter((b) => b.visible)
    .sort((a, b) => a.order - b.order);

  const kb = new InlineKeyboard();
  let rowItems = 0;
  const closeRowIfNeeded = (force: boolean): void => {
    if (force && rowItems > 0) {
      kb.row();
      rowItems = 0;
    }
  };

  // Primary trial button (top, own row) — only when a usable target exists.
  // Prefer the Mini App (richer activation flow), else the magic-link URL.
  // Rendered with `style: 'success'` (green) per the onboarding spec — it's a
  // positive, free-offer CTA that should stand out from the regular buttons.
  if (trialButton !== null && trialButton !== undefined) {
    const trialExtras: { icon_custom_emoji_id?: string; style: 'success' } = { style: 'success' };
    if (
      trialButton.iconCustomEmojiId !== null &&
      trialButton.iconCustomEmojiId !== undefined &&
      trialButton.iconCustomEmojiId.length > 0
    ) {
      trialExtras.icon_custom_emoji_id = trialButton.iconCustomEmojiId;
    }
    if (isTelegramSafeButtonUrl(trialButton.miniAppUrl)) {
      kb.webApp({ text: trialButton.text, ...trialExtras }, trialButton.miniAppUrl as string).row();
    } else if (isTelegramSafeButtonUrl(trialButton.url)) {
      kb.url({ text: trialButton.text, ...trialExtras }, trialButton.url as string).row();
    }
  }

  for (const btn of visible) {
    const localisedLabel = translator.resolveButtonLabel(btn.id, btn.label, lang);
    const label = btn.emoji ? `${btn.emoji} ${localisedLabel}` : localisedLabel;
    const binding = resolveButtonBinding(btn);

    // Bot API 9.4 (February 2026) lets bots whose owner has a Telegram
    // Premium subscription render `icon_custom_emoji_id` and `style`
    // (danger/success/primary) on inline-keyboard buttons. We forward
    // both fields to grammy through its object-form `kb.text({...}, data)`
    // API; clients that still see the bot from a non-Premium owner just
    // get the label without the icon and the default style. The
    // `style` enum values from the admin BotConfig already match
    // Telegram's contract verbatim, except DEFAULT (admin-only marker
    // for "no override") which we map to undefined.
    const styleValue = mapButtonStyle(btn.style);
    const iconValue =
      btn.iconCustomEmojiId !== null && btn.iconCustomEmojiId !== undefined && btn.iconCustomEmojiId.length > 0
        ? btn.iconCustomEmojiId
        : undefined;
    const buttonExtras: { icon_custom_emoji_id?: string; style?: 'danger' | 'success' | 'primary' } = {};
    if (iconValue !== undefined) buttonExtras.icon_custom_emoji_id = iconValue;
    if (styleValue !== undefined) buttonExtras.style = styleValue;

    let placed = false;
    if (binding.kind === 'webapp') {
      // Operator-supplied absolute URL takes priority; legacy built-in
      // miniapp routing falls back to `${miniAppUrl}${path}`.
      const operatorUrl = binding.target !== null && binding.target.length > 0
        ? binding.target
        : null;
      const fallbackUrl = miniAppUrl ? `${miniAppUrl}${binding.target ?? ''}` : null;
      const finalUrl = operatorUrl !== null && /^https?:\/\//i.test(operatorUrl)
        ? operatorUrl
        : fallbackUrl;
      if (!finalUrl) continue;
      closeRowIfNeeded(btn.onePerRow);
      kb.webApp({ text: label, ...buttonExtras }, finalUrl);
      placed = true;
    } else if (binding.kind === 'url') {
      const operatorUrl = binding.target !== null && binding.target.length > 0
        ? binding.target
        : null;
      const fallbackUrl = publicWebUrl ? `${publicWebUrl}${binding.target ?? ''}` : null;
      const baseUrl = operatorUrl !== null && /^https?:\/\//i.test(operatorUrl)
        ? operatorUrl
        : fallbackUrl;
      if (!baseUrl) continue;
      // Magic-link: stamp `?signin=<token>` so the SPA can complete
      // the auth handshake without bouncing the user through /sign-in.
      // Only applied to URL-kind buttons because they're the only
      // ones whose target is the cabinet domain we control.
      const finalUrl = attachSigninTokenToUrl(baseUrl, signinToken);
      closeRowIfNeeded(btn.onePerRow);
      kb.url({ text: label, ...buttonExtras }, finalUrl);
      placed = true;
    } else if (binding.kind === 'support_url') {
      // Direct deep-link to support chat — one tap, no intermediate
      // sub-screen. Falls back to a callback when the operator hasn't
      // set a real @username (resolveSupportDeepLink returns null for
      // numeric / empty handles); the legacy `help` callback handler
      // then surfaces a "Связаться: <id>" copy with the support
      // username inline.
      if (supportUrl !== null && supportUrl !== undefined) {
        closeRowIfNeeded(btn.onePerRow);
        kb.url({ text: label, ...buttonExtras }, supportUrl);
        placed = true;
      } else {
        closeRowIfNeeded(btn.onePerRow);
        kb.text({ text: label, ...buttonExtras }, btn.id);
        placed = true;
      }
    } else {
      // Callback. If the operator picked SCREEN action, the binding
      // target is the screen shortId — emit `screen:<shortId>` so the
      // universal dynamic-screen handler resolves it.
      const callbackData =
        binding.target !== null && binding.target.length > 0
          ? `screen:${binding.target}`
          : btn.id;
      closeRowIfNeeded(btn.onePerRow);
      kb.text({ text: label, ...buttonExtras }, callbackData);
      placed = true;
    }

    if (!placed) continue;
    if (btn.onePerRow) {
      kb.row();
      rowItems = 0;
    } else {
      rowItems++;
      if (rowItems === 2) {
        kb.row();
        rowItems = 0;
      }
    }
  }

  if (rowItems > 0) kb.row();
  return kb;
}
