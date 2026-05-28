// ── Bot config from rezeis-admin ─────────────────────────────────────────────
export interface BotEmojiEntry {
  unicode?: string    // regular emoji (fallback)
  tgEmojiId?: string // Telegram Premium custom emoji ID (numeric string)
}

export type BotEmojiMap = Record<string, BotEmojiEntry>
export type MenuTextEmojiIds = Record<string, string>

export interface BotVisualConfig {
  welcomeMessage: string
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
  deviceLimit: number | null
  expireAt: string
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
