/**
 * The guest chat's runtime config — on/off and the Turnstile keys — for the
 * anonymous support router (`api/routes/support-guest.ts`).
 *
 * The router kept it in a closure: 30 seconds, the last good value in memory,
 * and on a cold start with the panel down, `null` — which the page reads as
 * "enabled, no captcha" (W8 report D13). The form then rendered without the
 * captcha, and once the panel was back every conversation it sent was refused
 * `captcha_failed`, because the server side had the secret again and the page
 * had no token to give it.
 *
 * So the same guarantees the other settings groups have:
 *  - a config the panel answered is kept in reiwa's Redis
 *    (`infrastructure/config-versions/last-known-good.ts`), secret included —
 *    without the secret a captcha in the form cannot be checked;
 *  - a cold start serves that copy; only a process that has never seen a
 *    config answers `null`;
 *  - stale-while-revalidate, one read at a time, a failure remembered for the
 *    TTL instead of paid for by every visitor;
 *  - a generation, so a read begun before `invalidate()` cannot land the old
 *    config after it (memory note `invalidation-undone-by-inflight-read`).
 *
 * The panel sends no webhook for this group. The version poll
 * (`infrastructure/config-versions/poller.ts`) is what notices a change early;
 * the TTL catches the rest.
 */
import { configVersionOf } from '../config-versions/config-version.js';
import {
  GUEST_SUPPORT_LKG,
  LAST_KNOWN_GOOD_RETRY_MS,
  LAST_KNOWN_GOOD_UNREADABLE,
  NOOP_LAST_KNOWN_GOOD,
  type LastKnownGood,
  type LastKnownGoodStorePort,
  type LastKnownGoodUnreadable,
} from '../config-versions/last-known-good.js';
import type { AdminClient } from './admin-client.js';
import type { GuestRuntimeConfig } from './namespaces/support.js';

const CACHE_TTL_MS = 30_000;

export interface GuestSupportConfigCacheOptions {
  readonly ttlMs?: number;
  readonly lastKnownGood?: LastKnownGoodStorePort;
}

function isGuestRuntimeConfig(value: unknown): value is GuestRuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['enabled'] === 'boolean' &&
    typeof v['turnstileSiteKey'] === 'string' &&
    (typeof v['turnstileSecret'] === 'string' || v['turnstileSecret'] === null)
  );
}

export class GuestSupportConfigCache {
  private value: GuestRuntimeConfig | null = null;
  private version: string | null = null;
  private fetchedAt = 0;
  /** With nothing known: until when a read answers `null` without asking the panel. */
  private missUntil = 0;
  private inFlight: Promise<GuestRuntimeConfig | null> | null = null;
  /** Bumped by `invalidate()`; see the header. */
  private generation = 0;
  /**
   * The saved copy's read — kept once Redis answered it. A read Redis failed
   * is forgotten, so the next read asks again: kept, it made a restart that met
   * Redis a second too early drop the captcha for the whole outage (review
   * R2a-01).
   */
  private saved: Promise<LastKnownGood<Record<string, unknown>> | null | LastKnownGoodUnreadable> | null = null;
  private readonly ttlMs: number;
  private readonly lastKnownGood: LastKnownGoodStorePort;

  public constructor(
    private readonly fetchFn: () => Promise<GuestRuntimeConfig>,
    options: GuestSupportConfigCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.lastKnownGood = options.lastKnownGood ?? NOOP_LAST_KNOWN_GOOD;
  }

  /** The config; `null` only when no config was ever known, here or in Redis. */
  public async get(): Promise<GuestRuntimeConfig | null> {
    const held = this.value;
    if (held !== null) {
      if (Date.now() - this.fetchedAt >= this.ttlMs && this.inFlight === null) void this.startRefresh();
      return held;
    }
    if (Date.now() < this.missUntil) return null;
    return this.inFlight ?? this.startRefresh();
  }

  /**
   * Read the panel again on the next `get()`. What is held is kept and served
   * meanwhile: a guest page must not lose its captcha between two reads.
   */
  public invalidate(): void {
    this.fetchedAt = 0;
    this.missUntil = 0;
    this.inFlight = null;
    this.generation += 1;
  }

  /** The version of the config held — `null` while none is — for the version poll. */
  public heldVersion(): string | null {
    return this.value === null ? null : this.version;
  }

  /** The saved copy; read once Redis answers it, asked again after a read it failed. */
  private savedCopy(): Promise<LastKnownGood<Record<string, unknown>> | null | LastKnownGoodUnreadable> {
    let read = this.saved;
    if (read === null) {
      // A store that throws despite its contract could not read either.
      const loading = this.lastKnownGood
        .load(GUEST_SUPPORT_LKG)
        .catch((): LastKnownGoodUnreadable => LAST_KNOWN_GOOD_UNREADABLE);
      read = loading;
      this.saved = loading;
      void loading.then((copy) => {
        if (copy === LAST_KNOWN_GOOD_UNREADABLE && this.saved === loading) this.saved = null;
      });
    }
    return read;
  }

  private startRefresh(): Promise<GuestRuntimeConfig | null> {
    const refresh = this.refresh(this.generation);
    this.inFlight = refresh;
    void refresh.finally(() => {
      if (this.inFlight === refresh) this.inFlight = null;
    });
    return refresh;
  }

  private async refresh(startedAt: number): Promise<GuestRuntimeConfig | null> {
    try {
      const fresh = await this.fetchFn();
      if (!isGuestRuntimeConfig(fresh)) throw new TypeError('guest support config answer has the wrong shape');
      if (startedAt === this.generation) {
        this.value = fresh;
        this.version = configVersionOf(fresh);
        this.fetchedAt = Date.now();
        void this.lastKnownGood.save(GUEST_SUPPORT_LKG, fresh as unknown as Record<string, unknown>);
      }
      return fresh;
    } catch {
      if (this.value !== null) {
        // Remembered for the TTL: a panel outage is asked once per window.
        if (startedAt === this.generation) this.fetchedAt = Date.now();
        return this.value;
      }
      const copy = await this.savedCopy();
      if (copy !== null && copy !== LAST_KNOWN_GOOD_UNREADABLE && isGuestRuntimeConfig(copy.payload)) {
        if (startedAt === this.generation && this.value === null) {
          this.value = copy.payload;
          this.version = copy.hash;
          this.fetchedAt = Date.now();
        }
        return copy.payload;
      }
      // No config, remembered for the TTL — or, when Redis could not say
      // whether a copy exists, only for the store's pause: the copy is asked
      // for again then, not a TTL later.
      if (startedAt === this.generation) {
        this.missUntil = Date.now() + (copy === LAST_KNOWN_GOOD_UNREADABLE ? LAST_KNOWN_GOOD_RETRY_MS : this.ttlMs);
      }
      return null;
    }
  }
}

/**
 * One cache per panel client. A process has one client, so this is one cache
 * in production; keyed rather than a bare singleton so a second client — a test
 * file's next fake — is not answered by the first one's cache for 30 seconds.
 */
const instances = new WeakMap<AdminClient, GuestSupportConfigCache>();
let latest: GuestSupportConfigCache | null = null;
let configured: GuestSupportConfigCacheOptions = {};

/** Where the caches keep their saved copy. Called by `api/app.ts` before the first read. */
export function configureGuestSupportConfigCache(options: GuestSupportConfigCacheOptions): void {
  configured = options;
}

/** The process's cache for this client, built on first use. */
export function getGuestSupportConfigCache(adminClient: AdminClient): GuestSupportConfigCache {
  let cache = instances.get(adminClient);
  if (cache === undefined) {
    cache = new GuestSupportConfigCache(() => adminClient.support.getRuntimeConfig(), configured);
    instances.set(adminClient, cache);
  }
  latest = cache;
  return cache;
}

/** The cache last handed out, without building one — for the version poll. */
export function peekGuestSupportConfigCache(): GuestSupportConfigCache | null {
  return latest;
}
