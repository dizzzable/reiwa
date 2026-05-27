/**
 * Generic key-value session contract. Used by the API for browser
 * session cookies and by the bot's conversation FSM persistence.
 *
 * The implementation is Redis (see `infrastructure/redis/session.store.ts`),
 * but use-cases never depend on ioredis directly so they remain testable
 * with an in-memory `Map`-backed double.
 */
export interface SessionStorePort {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
