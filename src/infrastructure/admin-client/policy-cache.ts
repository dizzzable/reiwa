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
 * the TTL and the version poll (`infrastructure/config-versions/poller.ts`)
 * are the backstops for a webhook that did not arrive.
 *
 * The singleton is per PROCESS: reiwa-api and reiwa-bot each hold their own,
 * and the webhook lands in the API alone, so the bot's copy is reached only
 * through the relay to its `/invalidate-policy` listener route.
 *
 * ── With the panel unreachable ───────────────────────────────────────────────
 *
 * The LAST KNOWN policy, never "open to everybody" in its place — the owner's
 * rule (24.09.2026). A policy the panel answered is kept in memory and, when a
 * `lastKnownGood` store is configured, in reiwa's Redis too, so a restart
 * during an outage comes back with the operator's access mode, channel gate
 * and rules gate. Only a process that has never seen a policy — none in memory,
 * none in Redis — answers the `PUBLIC` stand-in (`_isFallback: true`).
 *
 * ── Never a long wait ────────────────────────────────────────────────────────
 *
 * The channel gate reads the policy in front of every bot update, and the bot
 * handles updates one at a time, so a read that waits out the transport
 * timeout stalls every user queued behind it:
 *  - a STALE policy is answered at once while one refresh runs in the
 *    background (stale-while-revalidate);
 *  - right after {@link PolicyCache.invalidate} a read waits for the panel so
 *    the operator's change applies on the very next read — but only
 *    `waitBudgetMs`, then it answers the policy it kept;
 *  - with nothing held, the saved copy is answered as soon as Redis gives it,
 *    and the panel is waited for `waitBudgetMs` only when there is none;
 *  - with nothing cached and nothing saved, the stand-in used to be handed out
 *    and forgotten, so every read of an outage went upstream again. A second
 *    failure in a row now keeps answering it for {@link FALLBACK_RETRY_MS}. One
 *    failure is retried at once, so a single blip right after boot or an
 *    invalidation does not open the gates for half a minute.
 *
 * ── On a press (the bot only) ────────────────────────────────────────────────
 *
 * Before an update is answered, the bot's freshness middleware brings the policy
 * up to a change reiwa has already heard of — the webhook's hint or a poll's
 * version in reiwa's Redis (`config-versions/latest.ts`), for a relay to the bot
 * that was lost — within the update's own budget ({@link PolicyCache.catchUp}).
 * It reads the panel once per change and never marks the policy superseded, so
 * the one-second wait above stays the invalidation's alone. The API process
 * never calls it.
 */
import type { AdminClient } from '../../lib/admin-client.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';
import { configVersionOf } from '../config-versions/config-version.js';
import {
  NOOP_LAST_KNOWN_GOOD,
  PLATFORM_POLICY_LKG,
  type LastKnownGood,
  type LastKnownGoodStorePort,
} from '../config-versions/last-known-good.js';
import type { KnownPanelChange } from '../config-versions/latest.js';
import { firstAnswer, settlesWithin } from '../config-versions/within-budget.js';
import type { PlatformPolicyShape } from './namespaces/system.js';

const CACHE_TTL_MS = 60_000;

/**
 * How long a version the key of latest versions keeps naming is not read for
 * again, once a read made on its account has landed with another one
 * (`catchUp`; `BotConfigCache` has the same rule).
 */
const POLLED_RECHECK_MS = 5 * 60 * 1000;

/** A read of the panel, whoever began it, as `catchUp` waits on it. */
interface ReadAttempt {
  readonly startedAt: number;
  readonly done: Promise<unknown>;
  settled: boolean;
  /** A press already waited its whole budget on it: the next ones do not. */
  waitedOut: boolean;
}

/**
 * How long a read waits for the panel when it has to wait at all — right after
 * an invalidation, or with nothing held and nothing saved. The budget of a
 * message's words in the bot (`bot/lib/config-within.ts`).
 */
export const POLICY_WAIT_BUDGET_MS = 1_000;

/**
 * How long the fallback is answered without asking the panel again, once two
 * reads in a row have failed with nothing cached.
 */
export const FALLBACK_RETRY_MS = 30_000;

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

export interface PolicyCacheOptions {
  readonly ttlMs?: number;
  /** Where the last policy the panel answered survives a restart. */
  readonly lastKnownGood?: LastKnownGoodStorePort;
  readonly waitBudgetMs?: number;
  readonly logger?: LoggerPort;
}

export class PolicyCache {
  private value: CachedPolicy | null = null;
  /** The version of `value` (`config-version.ts`), for the version poll. */
  private version: string | null = null;
  private fetchedAt = 0;
  /**
   * `value` is the policy from before an operator's change: {@link invalidate}
   * keeps it rather than dropping it, and a read waits `waitBudgetMs` for the
   * change before it answers with it.
   */
  private superseded = false;
  /** Until when a read with nothing cached answers the fallback without going upstream. */
  private fallbackUntil = 0;
  /** Failed reads in a row with nothing cached; the second one starts the fallback window. */
  private failuresWithNothingCached = 0;
  private inFlight: Promise<CachedPolicy> | null = null;
  /**
   * Bumped by {@link invalidate}. A fetch begun before the bump may have read
   * the policy from before the operator's change, so nobody may join it and it
   * may not store its answer — or an access-mode switch would be ignored for up
   * to a TTL with the webhook already spent. `generation` in
   * `api/routes/connect-page.ts` spells out the race.
   */
  private generation = 0;
  /**
   * The generation whose read already waited out its budget. The reads after
   * it, while the same fetch is still out, answer at once instead of each
   * waiting a budget of their own on the same hung panel.
   */
  private budgetSpent: number | null = null;
  /** The saved copy's read — once per process: nothing else writes it while we run. */
  private saved: Promise<LastKnownGood<Record<string, unknown>> | null> | null = null;
  /**
   * When the read `value` came from began; `-Infinity` for the saved copy. A
   * change reiwa heard of after it is one `value` may not have (`catchUp`).
   */
  private readStartedAt = Number.NEGATIVE_INFINITY;
  /** The newest read of the panel begun, whoever began it (`catchUp`). */
  private lastAttempt: ReadAttempt | null = null;
  /** The polled version a read was last begun for, and when (`catchUp`). */
  private polledCheck: { readonly version: string; readonly startedAt: number } | null = null;
  /** The change `catchUp` last began a read for: one read per change, whatever the clocks say. */
  private caughtUpFor: number | null = null;
  private readonly ttlMs: number;
  private readonly lastKnownGood: LastKnownGoodStorePort;
  private readonly waitBudgetMs: number;
  private readonly logger: LoggerPort | undefined;

  public constructor(
    private readonly fetchFn: () => Promise<PlatformPolicyShape>,
    options: number | PolicyCacheOptions = {},
  ) {
    const resolved: PolicyCacheOptions = typeof options === 'number' ? { ttlMs: options } : options;
    this.ttlMs = resolved.ttlMs ?? CACHE_TTL_MS;
    this.lastKnownGood = resolved.lastKnownGood ?? NOOP_LAST_KNOWN_GOOD;
    this.waitBudgetMs = resolved.waitBudgetMs ?? POLICY_WAIT_BUDGET_MS;
    this.logger = resolved.logger;
  }

  /**
   * Returns the cached policy. A stale one is returned at once and refreshed in
   * the background; one kept across an invalidation after at most the wait
   * budget; a missing one is the saved copy, else the panel's answer within the
   * budget, else the fallback. Concurrent callers share a single in-flight fetch.
   */
  public async get(): Promise<CachedPolicy> {
    const now = Date.now();
    const held = this.value;
    if (held !== null) {
      if (this.superseded) {
        const startedAt = this.generation;
        const pending = this.inFlight ?? this.startRefresh();
        if (this.budgetSpent === startedAt) return held;
        const fresh = await firstAnswer({ fetched: pending, budgetMs: this.waitBudgetMs });
        if (fresh !== null) return fresh;
        if (startedAt === this.generation) this.budgetSpent = startedAt;
        return held;
      }
      if (now - this.fetchedAt >= this.ttlMs && this.inFlight === null) {
        void this.startRefresh();
      }
      return held;
    }
    if (now < this.fallbackUntil) {
      return FALLBACK_POLICY;
    }
    const startedAt = this.generation;
    const pending = this.inFlight ?? this.startRefresh();
    if (this.budgetSpent === startedAt) return FALLBACK_POLICY;
    const first = await firstAnswer({ fetched: pending, saved: this.savedPolicy(), budgetMs: this.waitBudgetMs });
    if (first !== null) return first;
    if (startedAt === this.generation) this.budgetSpent = startedAt;
    return this.value ?? FALLBACK_POLICY;
  }

  /**
   * An operator changed the policy: the next read goes to the panel. The policy
   * held so far is KEPT, marked as superseded — it is what a read answers when
   * the panel does not answer within the budget, instead of the open stand-in.
   */
  public invalidate(): void {
    this.superseded = this.value !== null;
    this.fetchedAt = 0;
    // An operator change is exactly when the panel is reachable again.
    this.fallbackUntil = 0;
    this.failuresWithNothingCached = 0;
    // The fetch in flight too: a caller joining it would get the old policy.
    this.inFlight = null;
    this.generation += 1;
  }

  /** Sync read of the last cached value, mostly for diagnostics. */
  public peek(): CachedPolicy | null {
    return this.value;
  }

  /**
   * The version of the policy this process holds — `null` while it holds none —
   * for the version poll (`infrastructure/config-versions/poller.ts`).
   */
  public heldVersion(): string | null {
    return this.value === null ? null : this.version;
  }

  /**
   * Bring the policy up to a change reiwa already knows of, waiting for it at
   * most `budgetMs` — the bot's per-press refresh
   * (`bot/middleware/config-freshness.ts`), for the relay to the bot that did
   * not arrive. `known` is what reiwa's Redis holds for the policy
   * (`config-versions/latest.ts`): the webhook's hint, a poll's version.
   *
   * The rules of `BotConfigCache.catchUp`: behind when a hint, or a poll's
   * version that is not the one held, is newer than the read the policy came
   * from began; then the read begun since is waited for, or one is begun — in a
   * generation of its own, so a read from before the change is neither joined
   * nor kept; one read per change, one wait per read.
   *
   * Unlike {@link invalidate}, the policy is NOT marked superseded: the gate's
   * next `get()` answers at once from what is held, the new policy if the read
   * came within the press's budget — this never adds the invalidation's
   * one-second wait to a press. An invalidation's own evidence is `get()`'s to
   * wait for, not this. Nothing held: nothing to do — `get()` decides, the
   * `PUBLIC` stand-in included. Never rejects.
   */
  public async catchUp(known: KnownPanelChange, budgetMs: number): Promise<void> {
    if (this.value === null) return;
    const since = this.behindSince(known);
    if (since === null) return;
    let attempt = this.lastAttempt;
    if ((attempt === null || attempt.startedAt < since) && since !== this.caughtUpFor) {
      this.caughtUpFor = since;
      if (known.polled !== undefined && known.polled.version !== this.version) {
        this.polledCheck = { version: known.polled.version, startedAt: Date.now() };
      }
      // A read begun before the change may carry the policy from before it.
      this.generation += 1;
      void this.startRefresh();
      attempt = this.lastAttempt;
    }
    // Superseded: an invalidation's read is out, and the gate's own `get()`
    // waits for it — the press is not held for the same read twice.
    if (attempt === null || attempt.settled || attempt.waitedOut || this.superseded || budgetMs <= 0) return;
    if (!(await settlesWithin(attempt.done, budgetMs))) attempt.waitedOut = true;
  }

  /** The newest known change the held policy may not have, or `null`. */
  private behindSince(known: KnownPanelChange): number | null {
    let since: number | null = null;
    const newer = (at: number | undefined): void => {
      if (at === undefined || !(at > this.readStartedAt)) return;
      if (since === null || at > since) since = at;
    };
    newer(known.hintedAt);
    const polled = known.polled;
    if (polled !== undefined && polled.version !== this.version && !this.polledChecked(polled.version)) {
      newer(polled.at);
    }
    return since;
  }

  /** A read begun on account of this polled version has landed, and recently (`polledCheck`). */
  private polledChecked(version: string): boolean {
    const check = this.polledCheck;
    return (
      check !== null &&
      check.version === version &&
      this.readStartedAt >= check.startedAt &&
      Date.now() - check.startedAt < POLLED_RECHECK_MS
    );
  }

  /** The saved copy's payload, or `null`; read from the store once per process. */
  private savedPolicy(): Promise<CachedPolicy | null> {
    this.saved ??= this.lastKnownGood.load(PLATFORM_POLICY_LKG);
    const startedAt = this.generation;
    return this.saved.then((copy) => {
      if (copy === null) return null;
      const policy = copy.payload as unknown as CachedPolicy;
      // Held like an answer that has gone stale: served, and refreshed from
      // the panel on the next read past the TTL.
      if (startedAt === this.generation && this.value === null) {
        this.value = policy;
        this.version = copy.hash;
        this.fetchedAt = Date.now();
        this.readStartedAt = Number.NEGATIVE_INFINITY;
        this.logger?.info({}, 'PolicyCache: serving the last known policy saved before this start');
      }
      return policy;
    });
  }

  /** Starts one fetch and holds the in-flight slot until it settles. Never rejects. */
  private startRefresh(): Promise<CachedPolicy> {
    const readStartedAt = Date.now();
    const refresh = this.refresh(this.generation, readStartedAt);
    this.inFlight = refresh;
    const attempt: ReadAttempt = { startedAt: readStartedAt, done: refresh, settled: false, waitedOut: false };
    this.lastAttempt = attempt;
    void refresh.finally(() => {
      attempt.settled = true;
      // After an invalidate the slot may already hold a newer fetch.
      if (this.inFlight === refresh) this.inFlight = null;
    });
    return refresh;
  }

  /** `readStartedAt`: when this read began — the held policy's, if it lands. */
  private async refresh(startedAt: number, readStartedAt: number): Promise<CachedPolicy> {
    try {
      const fresh = await this.fetchFn();
      // The transport casts the body, so a panel answering `null` (or anything that
      // is not an object) would be cached as "the policy", handed to every caller
      // typed as one, and refetched on every read. It is a failed read.
      if (fresh === null || typeof fresh !== 'object') {
        throw new TypeError('platform policy answer is not an object');
      }
      if (startedAt === this.generation) {
        this.value = fresh;
        this.version = configVersionOf(fresh);
        this.readStartedAt = readStartedAt;
        this.fetchedAt = Date.now();
        this.fallbackUntil = 0;
        this.superseded = false;
        // What a restart during a panel outage serves. Only an answer no
        // invalidation overtook: the pre-change policy may not end up in it.
        void this.lastKnownGood.save(PLATFORM_POLICY_LKG, fresh as unknown as Record<string, unknown>);
      }
      return fresh;
    } catch {
      // Last-known-good if we have one (TTL extended to reduce upstream
      // pressure during the outage); the saved copy on a cold start; the
      // documented PUBLIC fallback only when neither exists.
      if (this.value !== null) {
        if (startedAt === this.generation) {
          this.fetchedAt = Date.now();
          // No more waiting for a change the panel cannot deliver: the kept
          // policy is served at once until the next refresh is due.
          this.superseded = false;
        }
        return this.value;
      }
      const saved = await this.savedPolicy();
      if (saved !== null) return saved;
      if (startedAt === this.generation) {
        this.failuresWithNothingCached += 1;
        if (this.failuresWithNothingCached >= 2) this.fallbackUntil = Date.now() + FALLBACK_RETRY_MS;
      }
      return FALLBACK_POLICY;
    }
  }
}

let instance: PolicyCache | null = null;
let configured: PolicyCacheOptions = {};

/**
 * Where the singleton keeps its saved copy, and what it logs through. Called by
 * each process's composition root before the first read (`api/app.ts`,
 * `bot/main.ts`); an instance built before the call keeps what it was built
 * with.
 */
export function configurePolicyCache(options: PolicyCacheOptions): void {
  configured = options;
}

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
  }, configured);
  return instance;
}

/** The singleton when one exists, without building it — for the version poll. */
export function peekPolicyCache(): PolicyCache | null {
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
