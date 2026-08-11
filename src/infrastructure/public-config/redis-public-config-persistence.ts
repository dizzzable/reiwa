/**
 * Redis-backed last-known-good public-config snapshot.
 *
 * This adapter receives the composition root's existing Redis client; it does
 * not own a second connection or its lifecycle. Reads and writes are
 * best-effort so Redis degradation cannot make the public SPA bootstrap fail.
 */
import type { Redis } from "ioredis";

import {
  describePublicConfigSnapshot,
  type PublicConfigPersistencePort,
  type PublicConfigSnapshot,
} from "../../application/ports/public-config-persistence.port.js";
import type { LoggerPort } from "../../application/ports/logger.port.js";
import {
  createPublicConfigRejectionNotifier,
  type PublicConfigRejectionNotifier,
} from "./rejection-notifier.js";

const DEFAULT_KEY = "reiwa:public-config:last-known-good";

export interface RedisPublicConfigPersistenceOptions {
  /** An already-connected, composition-root-owned Redis client. */
  readonly redis: Redis;
  readonly logger?: LoggerPort;
  /**
   * Operator-visible reporting for rejected snapshots. Supplied by the
   * composition root so the route and this adapter share one suppression
   * state; a log-only notifier is built from `logger` when omitted.
   */
  readonly rejectionNotifier?: PublicConfigRejectionNotifier;
  /** Override the storage key for isolated deployments and tests. */
  readonly key?: string;
}

export class RedisPublicConfigPersistence implements PublicConfigPersistencePort {
  private readonly redis: Redis;
  private readonly logger: LoggerPort | undefined;
  private readonly notifier: PublicConfigRejectionNotifier;
  private readonly key: string;

  constructor(options: RedisPublicConfigPersistenceOptions) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.notifier =
      options.rejectionNotifier ??
      createPublicConfigRejectionNotifier({ logger: options.logger });
    this.key = options.key ?? DEFAULT_KEY;
  }

  async load(): Promise<PublicConfigSnapshot | null> {
    try {
      const raw = await this.redis.get(this.key);
      if (raw === null || raw.length === 0) return null;

      const parsed: unknown = JSON.parse(raw);
      const rejection = describePublicConfigSnapshot(parsed);
      if (rejection !== null) {
        this.notifier.rejected("redis-load", rejection);
        return null;
      }
      this.notifier.accepted("redis-load");
      return parsed as PublicConfigSnapshot;
    } catch (err: unknown) {
      this.logger?.warn(
        { err, component: "RedisPublicConfigPersistence" },
        "Public-config snapshot load failed",
      );
      return null;
    }
  }

  async save(snapshot: PublicConfigSnapshot): Promise<void> {
    const rejection = describePublicConfigSnapshot(snapshot);
    if (rejection !== null) {
      this.notifier.rejected("redis-save", rejection);
      return;
    }
    this.notifier.accepted("redis-save");

    try {
      // Intentionally no expiry: this is a durable last-known-good snapshot,
      // not a short-lived response cache. A newer valid upstream response
      // atomically replaces it.
      await this.redis.set(this.key, JSON.stringify(snapshot));
    } catch (err: unknown) {
      this.logger?.warn(
        { err, component: "RedisPublicConfigPersistence" },
        "Public-config snapshot save failed",
      );
    }
  }
}
