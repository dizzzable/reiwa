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

import type { BotConfig, BotMenuButton, BotEmojiMap } from '../../infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import { renderBotCopy, renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';

export type ButtonKind = 'url' | 'webapp' | 'callback' | 'support_url';

export interface ButtonBinding {
  readonly kind: ButtonKind;
  readonly path?: string;
}

/**
 * A support button's callback when there is no public support username to open:
 * the one callback that answers it (`pages/help-callback.ts`).
 */
const SUPPORT_FALLBACK_CALLBACK = 'help';

/**
 * An address on this machine, which Telegram refuses on a button — and with it
 * the whole message. The HOST decides: `new URL(address).hostname` is exactly
 * `localhost` or `127.0.0.1`, and an address that does not parse is not local.
 * A substring test dropped the cabinet's own page whose query named localhost
 * (`/r?next=http://localhost/x`), which the release sent. The panel map's
 * copies (`reply-keyboard-utils.ts`, `menu-button-route.ts`) follow the same
 * rule, pinned by the same table in both repositories.
 */
export function isLocalAddress(address: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(address).hostname;
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '127.0.0.1';
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
  return !isLocalAddress(url);
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
  // `/plans`, not the `/subscribe` it was: the cabinet never had that page,
  // and a Mini App opened on a path with no page shows the home screen.
  vpn: { kind: 'webapp', path: '/plans' },
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

/**
 * «Кабинет» meaning the cabinet itself. It has two such shapes: the panel
 * seeds it as a link with no address (`actionType` url, `actionTarget`
 * null), and a config from before action types has no action at all and
 * reaches `BUTTON_KIND_MAP`, whose `/` is a path, not the operator's choice.
 * An address the operator typed, or any other action, is not this.
 */
function isDefaultCabinet(button: BotMenuButton, binding: ResolvedBinding): boolean {
  if (button.id !== 'cabinet' || binding.kind !== 'url') return false;
  return button.actionType === undefined || (button.actionTarget ?? '').length === 0;
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
   * One-time bot-signin token for URL-kind buttons that open the cabinet
   * (the origin of `publicWebUrl`). When set, such a URL gets a
   * `?signin=<token>` query parameter so the SPA recognises the
   * magic-link flow on whatever path the button opens and authenticates
   * the user without sending them through `/sign-in`. Buttons on any other
   * origin never carry it — see `attachSigninTokenToCabinetUrl`.
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
  /**
   * Operator emoji registry + custom-emoji packs, so button labels resolve
   * `{{KEY}}` / `:slug:` tokens to glyphs and promote a leading premium token
   * to the button's `icon_custom_emoji_id`. Optional/additive.
   */
  readonly botEmojis?: BotEmojiMap | null;
  readonly customEmojis?: Record<string, { id: string | null; fallback: string | null }> | null;
  readonly ownerHasPremium?: boolean;
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
 * The text a support chat opens with — the `?text=` of every support link,
 * read here and nowhere else.
 *
 * Plain text with every emoji token resolved to its glyph. A URL parameter
 * carries no entities, so a `:slug:` pack emoji or a `{{KEY}}` placeholder the
 * panel's picker put into `help.contact_prefill` reached support verbatim. A
 * premium pack emoji arrives as its fallback glyph.
 */
export function supportPrefill(
  translator: TranslatorPort,
  lang: SupportedLocale,
  emojis: Pick<BotConfig, 'botEmojis' | 'customEmojis'> | null | undefined,
): string {
  return renderBotCopy(
    translator.t('help.contact_prefill', lang),
    emojis?.botEmojis,
    emojis?.customEmojis,
    false,
  ).text;
}

/**
 * Resolve the support deep-link from the operator's admin handle (primary) and
 * the env handle (fallback), with a localized prefill. Returns `null` when
 * neither yields a usable public `@username` (numeric chat id / empty). Shared
 * by the main keyboard, screen `support_url` buttons, and error fallbacks so
 * they all build the identical `t.me/<handle>?text=<prefill>` target.
 */
export function resolveConfiguredSupportUrl(
  adminSupportUsername: string | null | undefined,
  envSupportUsername: string | null | undefined,
  prefill: string | null | undefined,
): string | null {
  const admin = (adminSupportUsername ?? '').replace(/^@+/, '').trim();
  const handle = admin.length > 0 ? admin : (envSupportUsername ?? '').trim();
  return resolveSupportDeepLink(handle, prefill);
}

/**
 * Where «Кабинет» sends a tap when it names no address of its own: the Mini
 * App's `/open-in-browser`, which opens the cabinet in the phone's own browser,
 * already signed in (owner's decision, 22.09.2026).
 *
 * Why not a link, as it used to be: Telegram, not the bot, picks where a link
 * opens — on a phone, its own in-app browser — and the sign-in key stamped
 * into it lived five minutes while the menu stayed in the chat for days, so
 * any later tap met the sign-in form; the key also went wherever the message
 * was forwarded. The Mini App is signed in by Telegram's launch data at the
 * moment of the tap, so nothing sits in the message at all.
 *
 * `null` without an HTTPS Mini App (dev): «Кабинет» stays the stamped link.
 */
export function cabinetBrowserEntryUrl(miniAppUrl: string | null | undefined): string | null {
  if (!isTelegramSafeButtonUrl(miniAppUrl)) return null;
  return `${(miniAppUrl as string).replace(/\/+$/, '')}/open-in-browser`;
}

/**
 * The address a main-menu «Mini App» button opens: an `http(s)://` target as
 * the operator typed it, anything else a path on the Mini App's own address.
 *
 * The path gets the leading slash it may lack. This was plain concatenation,
 * so a button set to `referrals` opened `https://cabinet.example.comreferrals`
 * — a host that does not exist — while the notification sender and the screen
 * renderer both add the slash. No target at all is the Mini App's own address;
 * the built-in map's paths (`/`) arrive here as targets too. `null` when there
 * is no Mini App address to put a path on.
 */
export function miniAppButtonUrl(
  miniAppUrl: string | null | undefined,
  target: string | null,
): string | null {
  return addressOn(miniAppUrl, target);
}

/**
 * A button's `target` as an address on `base`: an `http(s)://` target as the
 * operator typed it, anything else a path on `base` — given the slash a path
 * typed without one lacks, and never a doubled one. No target at all is `base`
 * itself. `null` when there is no base to put a path on.
 *
 * Shared by the Mini App button (`miniAppButtonUrl`) and the «Внешняя ссылка»
 * one, whose relative target was glued onto the cabinet's address as typed:
 * `plans` opened `https://cabinet.exampleplans`, a host that does not exist.
 */
function addressOn(base: string | null | undefined, target: string | null): string | null {
  const trimmed = (target ?? '').trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!base) return null;
  const root = base.replace(/\/+$/, '');
  if (trimmed.length === 0) return root;
  return `${root}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
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
 * The URL a keyboard button opens, carrying the sign-in token ONLY when that
 * URL is the cabinet.
 *
 * ── Why the origin is checked ──────────────────────────────────────────────
 *
 * The token is a credential, not a tracking tag: whoever presents it to
 * `/api/v1/auth/bot-signin` within its five minutes gets a cabinet session for
 * this customer — subscription links, payment methods, everything. And an
 * operator's `url` button can point anywhere: a news channel, a review site, a
 * partner. Every one of those used to receive `?signin=<token>` on every press,
 * in its access log and in anything it forwards the address to, and because
 * the customer went THERE rather than to the cabinet, nothing ever spent the
 * token before it expired. The pages already refuse to post this keyboard into
 * a group for the same reason (`isOwnPrivateChat`); the URL was the hole left.
 *
 * "The cabinet" is the origin of `publicWebUrl` — scheme, host and port, as
 * `URL` normalises them (letter case, a default port, a Cyrillic domain in
 * either spelling). Everything else is another origin: `www.` in front of the
 * cabinet's host, a trailing dot, `http://`, another port, a mirror domain.
 * Those may well serve the same cabinet — and they may just as well be a
 * landing page on another host with analytics that records every address, and
 * the bot cannot tell which. Such a button, or one whose address does not
 * parse, opens as the operator wrote it WITHOUT a token, and the customer has
 * to sign in there by hand: somebody who arrived through Telegram has no
 * password, so only the site's other sign-in options are left to them. A lost
 * convenience, never a leaked session — and the operator's fix is to write the
 * button with the cabinet's own address. With no `publicWebUrl` there is
 * nothing to compare against, so no token leaves at all.
 */
export function attachSigninTokenToCabinetUrl(
  url: string,
  token: string | null | undefined,
  cabinetUrl: string | null | undefined,
): string {
  if (token === null || token === undefined || token.length === 0) return url;
  if (!isSameOrigin(url, cabinetUrl)) return url;
  return attachSigninTokenToUrl(url, token);
}

function isSameOrigin(url: string, cabinetUrl: string | null | undefined): boolean {
  if (cabinetUrl === null || cabinetUrl === undefined || cabinetUrl.length === 0) return false;
  try {
    return new URL(url).origin === new URL(cabinetUrl).origin;
  } catch {
    return false;
  }
}

/**
 * STEALTHNET-style keyboard builder. Walks visible buttons in order,
 * places each on its own row when `onePerRow=true` or pairs them when
 * `onePerRow=false` (max 2 per row).
 */
export function buildMainKeyboard(options: MainKeyboardOptions): InlineKeyboard {
  const { buttons, miniAppUrl, publicWebUrl, lang, translator, supportUrl, signinToken, trialButton, botEmojis, customEmojis, ownerHasPremium } = options;
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
    const rawLabel = btn.emoji ? `${btn.emoji} ${localisedLabel}` : localisedLabel;
    const rendered = renderButtonLabel(rawLabel, botEmojis, customEmojis, ownerHasPremium ?? true);
    const label = rendered.text;
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
        : rendered.iconCustomEmojiId;
    const buttonExtras: { icon_custom_emoji_id?: string; style?: 'danger' | 'success' | 'primary' } = {};
    if (iconValue !== undefined) buttonExtras.icon_custom_emoji_id = iconValue;
    if (styleValue !== undefined) buttonExtras.style = styleValue;

    let placed = false;
    if (binding.kind === 'webapp') {
      const finalUrl = miniAppButtonUrl(miniAppUrl, binding.target);
      // An address Telegram refuses drops this button, not the menu: one bad
      // `web_app` URL fails the whole message it is attached to.
      if (!isTelegramSafeButtonUrl(finalUrl)) continue;
      closeRowIfNeeded(btn.onePerRow);
      kb.webApp({ text: label, ...buttonExtras }, finalUrl as string);
      placed = true;
    } else if (isDefaultCabinet(btn, binding) && cabinetBrowserEntryUrl(miniAppUrl) !== null) {
      // «Кабинет» meaning the cabinet itself (`isDefaultCabinet`). An operator
      // who typed an address, or chose another action, keeps exactly that.
      closeRowIfNeeded(btn.onePerRow);
      kb.webApp({ text: label, ...buttonExtras }, cabinetBrowserEntryUrl(miniAppUrl) as string);
      placed = true;
    } else if (binding.kind === 'url') {
      // An address the operator typed, or a page of the cabinet (`addressOn`).
      const baseUrl = addressOn(publicWebUrl, binding.target);
      if (!baseUrl) continue;
      // A local address drops this button, not the menu: Telegram refuses the
      // whole message for one, as it does for a `web_app` URL above. `http://`
      // stays — the panel saves it for a link, and Telegram opens it.
      if (isLocalAddress(baseUrl)) continue;
      // Magic-link: stamp `?signin=<token>` so the SPA can complete
      // the auth handshake without bouncing the user through /sign-in —
      // and only onto the cabinet's own origin. An operator's `url`
      // button may point at any site, and the token is a live session
      // credential; see `attachSigninTokenToCabinetUrl`.
      const finalUrl = attachSigninTokenToCabinetUrl(baseUrl, signinToken, publicWebUrl);
      closeRowIfNeeded(btn.onePerRow);
      kb.url({ text: label, ...buttonExtras }, finalUrl);
      placed = true;
    } else if (binding.kind === 'support_url') {
      // Direct deep-link to support chat — one tap, no intermediate
      // sub-screen. Falls back to the `help` callback when the operator
      // hasn't set a real @username (resolveSupportDeepLink returns null
      // for numeric / empty handles); the `help` handler then surfaces a
      // "Связаться: <id>" copy with the support username inline. `help`,
      // not the button's own ID: that was sent before, and only a button
      // whose ID happened to be `help` was ever answered.
      if (supportUrl !== null && supportUrl !== undefined) {
        closeRowIfNeeded(btn.onePerRow);
        kb.url({ text: label, ...buttonExtras }, supportUrl);
        placed = true;
      } else {
        closeRowIfNeeded(btn.onePerRow);
        kb.text({ text: label, ...buttonExtras }, SUPPORT_FALLBACK_CALLBACK);
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
