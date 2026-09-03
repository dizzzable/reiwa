/**
 * Redis-backed last-known-good copy of the connect-screen catalog.
 *
 * The in-process cache already survives a panel outage — but only for as long
 * as the process does. Restart the cabinet while the panel is down and the
 * catalog is gone, and because a missing catalog reads as "the connect screen
 * is switched off", the feature turns itself off for everybody with nothing
 * written anywhere to say why. That is the same failure the public-config
 * snapshot beside this file was built to prevent, so it is solved the same way
 * and on the same connection.
 *
 * Best-effort in both directions: a Redis problem must never be the reason a
 * customer cannot reach the screen. Every path answers `null` or does nothing.
 */
import type { Redis } from "ioredis";

import type { LoggerPort } from "../../application/ports/logger.port.js";

const DEFAULT_KEY = "reiwa:connect-page:last-known-good";
/**
 * Long enough to outlive an outage and a restart, short enough that a catalog
 * nobody has fetched in a fortnight is not resurrected onto a screen whose
 * apps have since changed.
 */
const TTL_SECONDS = 14 * 24 * 60 * 60;
/** The payload is small by design; anything this size is not our catalog. */
const MAX_BYTES = 2 * 1024 * 1024;

export interface ConnectPageSnapshotStore {
  /** The last catalog known to be good, or `null` when there is none to trust. */
  load(): Promise<unknown | null>;
  /** Record a catalog the panel actually served. */
  save(payload: unknown): Promise<void>;
}

/** For tests and Redis-free deployments. */
export const NOOP_CONNECT_PAGE_SNAPSHOT: ConnectPageSnapshotStore = {
  load: async () => null,
  save: async () => undefined,
};

export class RedisConnectPageSnapshot implements ConnectPageSnapshotStore {
  private readonly redis: Redis;
  private readonly logger: LoggerPort | undefined;
  private readonly key: string;

  public constructor(options: { redis: Redis; logger?: LoggerPort; key?: string }) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.key = options.key ?? DEFAULT_KEY;
  }

  public async load(): Promise<unknown | null> {
    try {
      const raw = await this.redis.get(this.key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      // A snapshot has to look like a catalog before it is handed to anything.
      // What is stored here was written by this process, but "written by us"
      // stops being true the moment a shape changes across a release.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      return "platforms" in parsed ? parsed : null;
    } catch (err: unknown) {
      this.logger?.warn({ err }, "connect-page snapshot could not be read");
      return null;
    }
  }

  public async save(payload: unknown): Promise<void> {
    try {
      if (typeof payload !== "object" || payload === null) return;
      const raw = JSON.stringify(payload);
      if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return;
      await this.redis.set(this.key, raw, "EX", TTL_SECONDS);
    } catch (err: unknown) {
      this.logger?.warn({ err }, "connect-page snapshot could not be written");
    }
  }
}
