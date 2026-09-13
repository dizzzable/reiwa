/**
 * Singleton in-memory cache for the rezeis-admin platform policy.
 *
 * The policy carries the access mode + channel/rules requirements + default
 * currency. It changes rarely (operator action) but is consulted on every
 * gated request, so we cache it with a short TTL and a single-flight
 * fetch so that bursts collapse onto one upstream request. The admin
 * webhook (`POST /api/v1/webhooks/rezeis` with
 * `event: 'reiwa.platform.policy_invalidated'`) calls
 * {@link PolicyCache.invalidate} so an operator change propagates instantly;
 * the TTL is a backstop for environments where the webhook leg is unavailable.
 *
 * The singleton is per PROCESS: reiwa-api and reiwa-bot each hold their own,
 * and the webhook lands in the API alone, so the bot's copy is reached only
 * through the relay to its `/invalidate-policy` listener route.
 *
 * Failure mode (Requirement 1.3): when admin is unreachable AND the cache
 * has no last-known-good value, callers receive a `PUBLIC`-mode fallback
 * with `_isFallback: true`. This is "fail open" by design — a transient
 * outage must not lock every user out.
 */
import type { AdminClient } from '../../lib/admin-client.js';
import type { PlatformPolicyShape } from './namespaces/system.js';

const CACHE_TTL_MS = 60_000;

export interface CachedPolicy extends PlatformPolicyShape {
  /** True when the value is the safe `PUBLIC` fallback (admin unreachable). */
  readonly _isFallback?: boolean;
}

const FALLBACK_POLICY: CachedPolicy = {
  accessMode: 'PUBLIC',
  rulesRequired: false,
  rulesLink: null,
  channelRequired: false,
  channelLink: null,
  defaultCurrency: 'USD',
  _isFallback: true,
};

export class PolicyCache {
  private value: CachedPolicy | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<CachedPolicy> | null = null;
  /**
   * Bumped by {@link invalidate}. A fetch begun before the bump may have read
   * the policy from before the operator's change, so nobody may join it and it
   * may not store its answer — or an access-mode switch would be ignored for up
   * to a TTL with the webhook already spent. `generation` in
   * `api/routes/connect-page.ts` spells out the race.
   */
  private generation = 0;

  public constructor(
    private readonly fetchFn: () => Promise<PlatformPolicyShape>,
    private readonly ttlMs: number = CACHE_TTL_MS,
  ) {}

  /**
   * Returns the cached policy, refreshing from upstream when stale or
   * missing. Concurrent callers share a single in-flight fetch.
   */
  public async get(): Promise<CachedPolicy> {
    const now = Date.now();
    if (this.value !== null && now - this.fetchedAt < this.ttlMs) {
      return this.value;
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const refresh = this.refresh(this.generation);
    this.inFlight = refresh;
    try {
      return await refresh;
    } finally {
      // After an invalidate the slot may already hold a newer fetch.
      if (this.inFlight === refresh) this.inFlight = null;
    }
  }

  /** Drops the cached value so the next `get()` refetches immediately. */
  public invalidate(): void {
    this.value = null;
    this.fetchedAt = 0;
    // The fetch in flight too: a caller joining it would get the old policy.
    this.inFlight = null;
    this.generation += 1;
  }

  /** Sync read of the last cached value, mostly for diagnostics. */
  public peek(): CachedPolicy | null {
    return this.value;
  }

  private async refresh(startedAt: number): Promise<CachedPolicy> {
    try {
      const fresh = await this.fetchFn();
      if (startedAt === this.generation) {
        this.value = fresh;
        this.fetchedAt = Date.now();
      }
      return fresh;
    } catch {
      // Fail open: return last-known-good if we have one (TTL extended
      // to reduce upstream pressure during the outage), otherwise the
      // documented PUBLIC fallback.
      if (this.value !== null) {
        if (startedAt === this.generation) this.fetchedAt = Date.now();
        return this.value;
      }
      return FALLBACK_POLICY;
    }
  }
}

let instance: PolicyCache | null = null;

/**
 * Lazily-initialised singleton bound to the AdminClient. Tests can pass
 * a stub via `setPolicyCache(...)` instead.
 */
export function getPolicyCache(adminClient: AdminClient | null): PolicyCache {
  if (instance !== null) return instance;
  instance = new PolicyCache(async () => {
    if (adminClient === null) {
      throw new Error('AdminClient not configured');
    }
    return adminClient.system.getPlatformPolicy();
  });
  return instance;
}

/**
 * Drops the cached policy WITHOUT creating the singleton — for a caller that
 * holds no admin client, which is the bot's `/invalidate-policy` route.
 *
 * `getPolicyCache` binds the singleton to the client it is first handed, for
 * the life of the process, so `getPolicyCache(null).invalidate()` in a process
 * that has not read the policy yet would leave every later read on the PUBLIC
 * fallback. With no instance there is nothing stale to drop.
 */
export function invalidatePolicyCache(): void {
  instance?.invalidate();
}

/** Test hook — overrides the singleton with a custom cache. */
export function setPolicyCache(cache: PolicyCache | null): void {
  instance = cache;
}
