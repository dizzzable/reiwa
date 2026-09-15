/**
 * A map whose entries each carry the deadline they are trusted until.
 *
 * The channel gate keeps a handful of per-user and per-chat memories, each
 * trusted for a different window — a pass for a minute, a "not subscribed" for
 * ten seconds, a refused chat for as long as Telegram asked us to wait. The
 * first version kept one map of passes and aged every entry by the LONGEST
 * window, so a pass trusted for sixty seconds sat in memory for a day, and a
 * busy bot tripped `bounded-map`'s "live entries" warning with entries nobody
 * would ever read again.
 *
 * Here an entry expires by its own deadline — and a later `set` never SHORTENS
 * it. A back-off is the case that matters: a 429 naming sixty seconds, then a
 * network failure from a call issued before it that asks for five, must still
 * wait the sixty. Every other memory is set with one fixed window, where the
 * later deadline is the new one anyway.
 *
 * Memory is bounded twice:
 *  - expired entries are swept on write, at most once per `sweepEveryMs`, so a
 *    flood of writes does not pay an O(size) walk each;
 *  - past `maxEntries` the oldest entries are dropped. Everything these maps
 *    hold is a shortcut (a remembered answer, a back-off), so losing an entry
 *    costs one extra question to Telegram — never a wrong answer — which is
 *    the right trade against unbounded growth under a flood of distinct users.
 */
export interface TtlMapOptions {
  /** Hard ceiling; the oldest entries go first once it is passed. */
  readonly maxEntries: number;
  /** Minimum time between two sweeps of expired entries. */
  readonly sweepEveryMs?: number;
}

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

const DEFAULT_SWEEP_EVERY_MS = 10_000;

export class TtlMap<K, V = true> {
  private readonly entries = new Map<K, Entry<V>>();
  private lastSweepAt = 0;

  public constructor(private readonly options: TtlMapOptions) {}

  /** The value, or `undefined` once its deadline has passed. */
  public get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Sets `key` to `value` until `ttlMs` from now — or until the deadline it
   * already had, when that one is later.
   */
  public set(key: K, value: V, ttlMs: number): void {
    const now = Date.now();
    const current = this.entries.get(key);
    const expiresAt = Math.max(now + ttlMs, current !== undefined && now < current.expiresAt ? current.expiresAt : 0);
    // Re-inserted, so iteration order stays oldest-first for the eviction below.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    this.prune();
  }

  public delete(key: K): void {
    this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
    this.lastSweepAt = 0;
  }

  /** Entries held, expired ones not yet swept included. */
  public get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = Date.now();
    if (now - this.lastSweepAt >= (this.options.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS)) {
      this.lastSweepAt = now;
      for (const [key, entry] of this.entries) {
        if (now >= entry.expiresAt) this.entries.delete(key);
      }
    }
    if (this.entries.size <= this.options.maxEntries) return;
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
