/**
 * Singleton in-memory cache for the rezeis-admin platform policy.
 *
 * The policy carries the access mode + channel/rules requirements + default
 * currency. It changes rarely (operator action) but is consulted on every
 * gated request, so we cache it with a short TTL and a single-flight
 * fetch so that bursts collapse onto one upstream request. The admin
 * webhook (`POST /api/v1/webhooks/rezeis` with
 * `event: 'platform-policy-invalidated'`) calls {@link PolicyCache.invalidate}
 * so an operator change propagates instantly; the TTL is a backstop for
 * environments where the webhook leg is unavailable.
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
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** Drops the cached value so the next `get()` refetches immediately. */
  public invalidate(): void {
    this.value = null;
    this.fetchedAt = 0;
  }

  /** Sync read of the last cached value, mostly for diagnostics. */
  public peek(): CachedPolicy | null {
    return this.value;
  }

  private async refresh(): Promise<CachedPolicy> {
    try {
      const fresh = await this.fetchFn();
      this.value = fresh;
      this.fetchedAt = Date.now();
      return fresh;
    } catch {
      // Fail open: return last-known-good if we have one (TTL extended
      // to reduce upstream pressure during the outage), otherwise the
      // documented PUBLIC fallback.
      if (this.value !== null) {
        this.fetchedAt = Date.now();
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

/** Test hook — overrides the singleton with a custom cache. */
export function setPolicyCache(cache: PolicyCache | null): void {
  instance = cache;
}
