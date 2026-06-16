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

export interface ConfigPersistencePort {
  /** Load the persisted last-known-good config, or `null` when none/invalid. */
  load(): Promise<BotConfig | null>;
  /** Persist the latest successfully-fetched config. Best-effort. */
  save(config: BotConfig): Promise<void>;
}

/** No-op persistence — used in tests and when no durable store is configured. */
export const NOOP_CONFIG_PERSISTENCE: ConfigPersistencePort = {
  load: async () => null,
  save: async () => undefined,
};
