/**
 * ConfigPersistencePort
 * ─────────────────────
 * Durable last-known-good store for the bot-config snapshot. Lets the bot
 * survive a reboot where rezeis is briefly unreachable: instead of falling
 * back to the hardcoded Reiwa default (wrong branding + banner), reiwa seeds
 * its cache from the last config it successfully fetched.
 *
 * Both methods are best-effort and MUST NOT throw — a store outage degrades
 * gracefully to in-memory + hardcoded-default behavior. Implementations:
 *   - Redis-backed adapter (production)
 *   - no-op adapter (tests / when Redis is absent)
 */
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import type { LastKnownGoodUnreadable } from '../../infrastructure/config-versions/last-known-good.js';

export interface ConfigPersistencePort {
  /**
   * Load the persisted last-known-good config; `null` when the store says there
   * is none (or none valid); `LAST_KNOWN_GOOD_UNREADABLE` when the store could
   * not be read — not "none": the caller asks again later.
   */
  load(): Promise<BotConfig | null | LastKnownGoodUnreadable>;
  /**
   * Persist the latest successfully-fetched config. Best-effort. `version` is
   * the panel's version of it, for a config the bot stamped after the panel
   * answered (its Telegram file ids); the config's own version otherwise.
   */
  save(config: BotConfig, version?: string): Promise<void>;
}

/** No-op persistence — used in tests and when no durable store is configured. */
export const NOOP_CONFIG_PERSISTENCE: ConfigPersistencePort = {
  load: async () => null,
  save: async () => undefined,
};
