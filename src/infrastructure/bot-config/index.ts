/**
 * Bot-config barrel.
 *
 * Reiwa-shaped DTOs that mirror the rezeis-admin `BotButton`,
 * `BotEmoji`, `BotText` tables, plus the emoji-rendering helpers used
 * by message builders to attach Telegram premium custom-emoji entities
 * inline. Wave 3 will introduce a `BotConfigPort` that wraps the
 * AdminClient call site so consumers depend on the port, not the raw
 * DTO surface; until then importing the types directly is fine.
 */
export type {
  BotConfig,
  BotEmojiEntry,
  BotEmojiMap,
  BotFeatures,
  BotMenuButton,
  BotVisualConfig,
  MenuTextEmojiIds,
  Plan,
  Subscription,
  TgBoldEntity,
  TgCustomEmojiEntity,
  TgEntity,
} from './types.js';
export {
  DEFAULT_UNICODE,
  firstCharLengthUtf16,
  joinLines,
  lineWithEmoji,
  resolvePlaceholders,
  resolveUnicode,
  utf16Length,
} from './emoji-utils.js';
export { BotConfigCache, DEFAULT_BOT_CONFIG } from './cache.js';
export type { BotConfigCacheOptions } from './cache.js';
