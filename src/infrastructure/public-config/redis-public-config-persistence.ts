/**
 * Redis-backed last-known-good public-config snapshot.
 *
 * Kept by the store every panel settings group shares
 * (`infrastructure/config-versions/last-known-good.ts`), on the composition
 * root's existing Redis client; this adapter owns no connection of its own.
 * Reads and writes are best-effort so Redis degradation cannot make the public
 * SPA bootstrap fail.
 *
 * The snapshot used to live under `reiwa:public-config:last-known-good` with no
 * shape number and no age. That key is read once, as a fallback, and deleted by
 * the first save under the new one.
 */
import type { Redis } from "ioredis";

import {
  describePublicConfigSnapshot,
  type PublicConfigPersistencePort,
  type PublicConfigSnapshot,
} from "../../application/ports/public-config-persistence.port.js";
import type { LoggerPort } from "../../application/ports/logger.port.js";
import {
  RedisLastKnownGoodStore,
  type LastKnownGoodGroup,
  type LastKnownGoodStorePort,
} from "../config-versions/last-known-good.js";
import {
  createPublicConfigRejectionNotifier,
  type PublicConfigRejectionNotifier,
} from "./rejection-notifier.js";

/**
 * The public config's group in the last-known-good store. The store only asks
 * for an object here: the full guard runs in `load()`, where a rejection can be
 * reported with the key it failed on.
 */
export const PUBLIC_CONFIG_LKG: LastKnownGoodGroup<PublicConfigSnapshot> = {
  name: "public-config",
  shape: 1,
  legacyKey: "reiwa:public-config:last-known-good",
  accepts: (payload: unknown): payload is PublicConfigSnapshot =>
    typeof payload === "object" && payload !== null && !Array.isArray(payload),
};

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
  /**
   * The store to keep the copy in. Defaults to one on `redis`; the composition
   * root hands in the one it shares with the other groups.
   */
  readonly store?: LastKnownGoodStorePort;
}

export class RedisPublicConfigPersistence implements PublicConfigPersistencePort {
  private readonly store: LastKnownGoodStorePort;
  private readonly notifier: PublicConfigRejectionNotifier;

  constructor(options: RedisPublicConfigPersistenceOptions) {
    this.store =
      options.store ?? new RedisLastKnownGoodStore({ redis: options.redis, logger: options.logger });
    this.notifier =
      options.rejectionNotifier ??
      createPublicConfigRejectionNotifier({ logger: options.logger });
  }

  async load(): Promise<PublicConfigSnapshot | null> {
    return (await this.loadServed())?.snapshot ?? null;
  }

  /**
   * The copy and the panel version it was served under. The copy is judged
   * whole: it is what a restart SERVES, and it was whole when it was saved —
   * the per-field fallback runs before `save`, never on this read.
   */
  async loadServed(): Promise<{ readonly snapshot: PublicConfigSnapshot; readonly version: string } | null> {
    const saved = await this.store.load(PUBLIC_CONFIG_LKG);
    if (saved === null) return null;
    const rejection = describePublicConfigSnapshot(saved.payload);
    if (rejection !== null) {
      this.notifier.rejected("redis-load", rejection);
      return null;
    }
    this.notifier.accepted("redis-load");
    return { snapshot: saved.payload, version: saved.hash };
  }

  async save(snapshot: PublicConfigSnapshot, version?: string): Promise<void> {
    const rejection = describePublicConfigSnapshot(snapshot);
    if (rejection !== null) {
      this.notifier.rejected("redis-save", rejection);
      return;
    }
    this.notifier.accepted("redis-save");
    // No expiry: this is a durable last-known-good snapshot, not a short-lived
    // response cache. A newer valid upstream response replaces it. Kept under
    // the PANEL's version of the answer it was served from: when the per-field
    // fallback kept a previous value the snapshot's own hash is not that
    // version, and a restart must report what the panel sent, or the panel's
    // delivery check would read every partial accept as "not applied".
    await this.store.save(PUBLIC_CONFIG_LKG, snapshot, version);
  }
}
