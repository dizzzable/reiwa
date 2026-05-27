/**
 * Per-user locale cache contract.
 *
 * Tracks the persisted locale choice for a Telegram user id (decision
 * key on which the bot's auto-detect middleware decides whether to
 * adopt the device language or trust an existing choice).
 *
 * Wave 1B shipped an in-memory implementation
 * (`infrastructure/i18n/locale-detector.UserLocaleCache`); Wave 8B
 * adds a Redis-backed implementation
 * (`infrastructure/i18n/redis-user-locale-cache.RedisUserLocaleCache`).
 * Both implement this surface so call sites swap via DI without code
 * changes.
 *
 * The synchronous API on the in-memory cache is preserved as
 * `*Sync()` reads where possible — the Redis-backed variant exposes
 * async equivalents because Redis IO is inherently async. Use cases
 * should treat the async variants as the canonical surface and keep
 * the sync hooks for hot-path bot updates that already have the
 * locale buffered locally.
 */
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

export interface UserLocaleCachePort {
  get(userId: number): Promise<SupportedLocale>;
  set(userId: number, lang: string | SupportedLocale): Promise<void>;
  has(userId: number): Promise<boolean>;
}
