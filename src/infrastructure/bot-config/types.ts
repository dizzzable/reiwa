// ── Bot config from rezeis-admin ─────────────────────────────────────────────
export interface BotEmojiEntry {
  unicode?: string    // regular emoji (fallback)
  tgEmojiId?: string // Telegram Premium custom emoji ID (numeric string)
}

export type BotEmojiMap = Record<string, BotEmojiEntry>
export type MenuTextEmojiIds = Record<string, string>

export interface BotVisualConfig {
  welcomeMessage: string
  /**
   * Optional English welcome message (operator's `bot.welcome_message@en`
   * override). When set and the user's locale is EN, the bot greets with
   * this instead of `welcomeMessage`. `null`/absent → serve the base
   * (RU) greeting to everyone.
   */
  welcomeMessageEn?: string | null
  botDescription: string
  supportUsername: string
  channelUsername: string
  subscriptionInfoFormat: 'full' | 'compact' | 'minimal'
  /**
   * URL of the banner image sent before the welcome message on `/start`.
   * `null` means "skip the banner". Operators set this through the
   * admin bot editor (`bot-config` → texts → `bot.banner_url`).
   */
  bannerUrl?: string | null
  /**
   * When `true`, reiwa uses the global `bannerUrl` as the banner on every
   * dynamic screen that doesn't carry its own media. When `false`/absent,
   * only screens with their own media show a banner. Managed via the
   * main-menu inspector in Bot Studio (`bot.banner_apply_all`). Additive.
   */
  bannerApplyAll?: boolean
  /**
   * Resolved Telegram `file_id` of the banner, stamped by reiwa after a
   * successful `sendPhoto` and carried into the persisted last-known-good
   * snapshot (Workstream 4). On a cold restart reiwa can re-send the
   * welcome banner via this `file_id` without re-fetching the bytes from
   * rezeis, so a custom banner survives a reboot even before the first
   * upstream config fetch lands. Additive; `null`/absent → no cached id.
   */
  bannerFileId?: string | null
}

export interface BotFeatures {
  referralsEnabled: boolean
  promoCodesEnabled: boolean
  trialEnabled: boolean
  miniAppEnabled: boolean
  activityFeedEnabled: boolean
  partnersEnabled: boolean
}

export interface BotMenuButton {
  id: string
  emoji: string
  label: string
  visible: boolean
  order: number
  style: 'primary' | 'success' | 'danger' | 'default'
  onePerRow: boolean
  /**
   * Optional Telegram custom-emoji id (premium emoji) used as the inline
   * keyboard button icon via `icon_custom_emoji_id` (Bot API 9.4+).
   * Telegram only renders the icon when the bot owner has Telegram
   * Premium; otherwise the field is silently ignored. `null` / `undefined`
   * means "no icon configured".
   */
  iconCustomEmojiId?: string | null
  /**
   * Operator-configured routing for the button. When unset / unknown,
   * reiwa falls back to its built-in `BUTTON_KIND_MAP` (keeps legacy
   * reserved ids working: cabinet/invite/rules/help). Lowercase string
   * so we don't have to import a Prisma enum into reiwa.
   */
  actionType?: 'callback' | 'url' | 'webapp' | 'screen' | 'support_url'
  /**
   * Action payload — interpretation depends on `actionType`:
   *   - `url` / `webapp` → absolute URL (Telegram-safe required)
   *   - `screen`         → BotFlowScreen.shortId
   *   - `callback` / `support_url` → unused
   */
  actionTarget?: string | null
}

export interface BotConfig {
  buttons: BotMenuButton[]
  visual: BotVisualConfig
  features: BotFeatures
  botEmojis: BotEmojiMap
  menuTextCustomEmojiIds: MenuTextEmojiIds
  /**
   * Flat translation map keyed by `<i18n key>` or `button.<id>.<lang>`.
   * Populated from rezeis-admin's `BotText` table by the
   * `/api/internal/bot-config` endpoint. Used by `i18n.t(...)` (after
   * `setTranslations(...)`) and by the keyboard builder for per-button
   * label localisation. Optional because reiwa boots in degraded mode
   * with the hard-coded RU baseline when admin is unreachable.
   */
  translations?: Record<string, string>
  /**
   * Operator custom-emoji library projected for bot copy: `:slug:` →
   * `{ id, fallback }`. `id` is the Telegram `custom_emoji_id` (premium
   * render); `fallback` is the unicode glyph shown otherwise. reiwa replaces
   * `:slug:` tokens in the welcome greeting with the fallback glyph plus a
   * custom-emoji entity when `id` is present. Optional/additive.
   */
  customEmojis?: Record<string, { id: string | null; fallback: string | null }>
  /**
   * Whether the bot owner's account has Telegram Premium. When `false`,
   * reiwa strips `custom_emoji` entities from rendered copy so a non-premium
   * owner's messages never fail to send. Defaults to `true` when absent.
   */
  botEmojiOwnerHasPremium?: boolean
  /**
   * Operator-managed dynamic screens projected from the BotFlow graph
   * (rezeis-admin). When a published flow exists, the screens listed
   * here override reiwa's built-in sub-menus (help / rules / invite),
   * letting operators rewrite copy + buttons + structure end-to-end
   * from the admin Bot Studio. Empty array → built-in fallback in
   * effect (the ship-default UX every reiwa instance comes with).
   */
  screens?: BotScreen[]
  /**
   * Identifier of the published flow that produced `screens`. Used as
   * a cache-key suffix so reiwa knows when to invalidate per-screen
   * caches. Empty string when no flow is published.
   */
  screensVersion?: string
  /**
   * Operator-assigned premium-emoji icons for built-in system buttons
   * (back / invite_share / rules_open / help_contact …), keyed by a stable
   * system-button id → Telegram `custom_emoji_id`. reiwa applies them as
   * `icon_custom_emoji_id`. Optional/additive — absent on older payloads.
   */
  systemButtonIcons?: Record<string, string>
}

/**
 * Operator-managed bot screen rendered as a Telegram message with an
 * optional inline keyboard. When the user presses a reply-keyboard
 * button or an inline button whose `targetShortId` points at this
 * screen, reiwa renders the screen via `editMessageContent`.
 */
export interface BotScreen {
  id: string
  shortId: string
  name: string
  textRu: string
  textEn: string
  parseMode: 'html' | 'markdown' | 'plain'
  mediaType: 'photo' | 'video' | 'document' | 'animation' | null
  mediaFileId: string | null
  mediaUrl: string | null
  isRoot: boolean
  buttons: readonly BotScreenButton[]
}

/**
 * A button rendered inside a dynamic screen. `action: 'navigate'`
 * targets another screen by `targetShortId`; the other action types
 * map onto Telegram's native button kinds (URL, Mini App, callback)
 * or reiwa's built-in navigation primitives (back, start_over).
 */
export interface BotScreenButton {
  id: string
  labelRu: string
  labelEn: string
  row: number
  col: number
  action: 'navigate' | 'url' | 'webapp' | 'callback' | 'back' | 'start_over' | 'support_url'
  targetShortId: string | null
  url: string | null
  webAppUrl: string | null
  callbackAction: string | null
  style: 'default' | 'primary' | 'success' | 'danger'
  iconCustomEmojiId: string | null
}

// ── Telegram entity types ─────────────────────────────────────────────────────
export interface TgCustomEmojiEntity {
  type: 'custom_emoji'
  offset: number
  length: number
  custom_emoji_id: string
}

export interface TgBoldEntity {
  type: 'bold'
  offset: number
  length: number
}

export type TgEntity = TgCustomEmojiEntity | TgBoldEntity

// ── API response types ────────────────────────────────────────────────────────
export interface Subscription {
  id: number
  status: 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED' | 'DELETED'
  isTrial: boolean
  trafficLimit: number | null
  /** Traffic consumed so far (GB); null when the panel usage is unavailable. */
  trafficUsed?: number | null
  deviceLimit: number | null
  /** Legacy alias for the expiry timestamp. */
  expireAt?: string
  /** Canonical expiry timestamp (ISO) from the internal subscription payload. */
  expiresAt?: string | null
  /** Human-readable Remnawave profile name shown on the mini-profile. */
  profileName?: string | null
  url: string
  plan: { id: number; name: string; type: string } | null
}

export interface Plan {
  id: number
  name: string
  trafficLimit: number | null
  deviceLimit: number | null
  durations: Array<{
    days: number
    prices: Array<{ currency: string; price: number }>
  }>
}
