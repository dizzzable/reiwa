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
}

export interface BotConfig {
  buttons: BotMenuButton[]
  visual: BotVisualConfig
  features: BotFeatures
  botEmojis: BotEmojiMap
  menuTextCustomEmojiIds: MenuTextEmojiIds
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
