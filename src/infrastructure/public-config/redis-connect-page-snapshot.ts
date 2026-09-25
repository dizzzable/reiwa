/**
 * Redis-backed last-known-good copy of the connect-screen catalog.
 *
 * The in-process cache already survives a panel outage — but only for as long
 * as the process does. Restart the cabinet while the panel is down and the
 * catalog is gone, and because a missing catalog reads as "the connect screen
 * is switched off", the feature turns itself off for everybody with nothing
 * written anywhere to say why. That is the same failure the public-config
 * snapshot beside this file was built to prevent, so it is solved the same way:
 * by the store every panel settings group shares
 * (`infrastructure/config-versions/last-known-good.ts`).
 *
 * The copy used to live under `reiwa:connect-page:last-known-good` with a
 * 14-day TTL. That key is read once, as a fallback, and deleted by the first
 * save under the new one. The TTL is gone: it turned an outage longer than a
 * fortnight back into "the screen is switched off", which is the thing the copy
 * exists to prevent.
 *
 * Best-effort in both directions: a Redis problem must never be the reason a
 * customer cannot reach the screen. Nothing throws; a Redis that could not be
 * read answers the store's "unreadable", which the route must not remember as
 * "no copy".
 */
import type { Redis } from "ioredis";

import type { LoggerPort } from "../../application/ports/logger.port.js";
import { configVersionOf } from "../config-versions/config-version.js";
import {
  LAST_KNOWN_GOOD_UNREADABLE,
  RedisLastKnownGoodStore,
  type LastKnownGoodGroup,
  type LastKnownGoodStorePort,
} from "../config-versions/last-known-good.js";

/** The payload is small by design; anything this size is not our catalog. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The catalog's group in the last-known-good store. A copy has to look like a
 * catalog before it is handed to anything: what is stored here was written by
 * this process, but "written by us" stops being true the moment a shape
 * changes across a release.
 */
export const CONNECT_PAGE_LKG: LastKnownGoodGroup<Record<string, unknown>> = {
  name: "connect-page",
  shape: 1,
  legacyKey: "reiwa:connect-page:last-known-good",
  accepts: (payload: unknown): payload is Record<string, unknown> =>
    typeof payload === "object" && payload !== null && !Array.isArray(payload) && "platforms" in payload,
  maxBytes: MAX_BYTES,
};

export interface ConnectPageSnapshotStore {
  /**
   * The last catalog known to be good; `null` when there is none to trust;
   * `LAST_KNOWN_GOOD_UNREADABLE` when Redis could not be read — not "none".
   */
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
  private readonly store: LastKnownGoodStorePort;

  public constructor(options: { redis: Redis; logger?: LoggerPort; store?: LastKnownGoodStorePort }) {
    this.store = options.store ?? new RedisLastKnownGoodStore({ redis: options.redis, logger: options.logger });
  }

  public async load(): Promise<unknown | null> {
    const copy = await this.store.load(CONNECT_PAGE_LKG);
    return copy === null || copy === LAST_KNOWN_GOOD_UNREADABLE ? copy : copy.payload;
  }

  public async save(payload: unknown): Promise<void> {
    if (!CONNECT_PAGE_LKG.accepts(payload)) return;
    await this.store.save(CONNECT_PAGE_LKG, payload);
  }
}

/**
 * Which catalog the connect screen holds, for the version poll
 * (`infrastructure/config-versions/poller.ts`).
 *
 * The screen's cache is private to `api/routes/connect-page.ts`, but every
 * catalog it keeps goes through its snapshot store first: a panel answer is
 * saved before it is cached, and a cold start during an outage loads the copy
 * it serves. So the version is taken there, on the way through, and forgotten
 * when the route's cache is reset — after which the screen holds nothing
 * stale, only a read still to make.
 */
export class ConnectPageVersionTracker implements ConnectPageSnapshotStore {
  private held: string | null = null;

  public constructor(private readonly inner: ConnectPageSnapshotStore) {}

  public async load(): Promise<unknown | null> {
    const copy = await this.inner.load();
    if (copy !== null && copy !== LAST_KNOWN_GOOD_UNREADABLE) this.held = configVersionOf(copy);
    return copy;
  }

  public save(payload: unknown): Promise<void> {
    // Before the write, not after it: the route caches the catalog on this
    // same turn, whatever Redis does with the copy.
    this.held = configVersionOf(payload);
    return this.inner.save(payload);
  }

  /** The version of the catalog the screen holds; `null` when it holds none. */
  public heldVersion(): string | null {
    return this.held;
  }

  /** Called beside `resetConnectPageCache()`: the screen holds nothing now. */
  public forget(): void {
    this.held = null;
  }
}
