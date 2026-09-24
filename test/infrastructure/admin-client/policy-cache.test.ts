import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminClient } from '../../../src/infrastructure/admin-client/admin-client.js';
import type { PlatformPolicyShape } from '../../../src/infrastructure/admin-client/namespaces/system.js';
import {
  PolicyCache,
  getPolicyCache,
  invalidatePolicyCache,
  setPolicyCache,
} from '../../../src/infrastructure/admin-client/policy-cache.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import type {
  LastKnownGood,
  LastKnownGoodStorePort,
} from '../../../src/infrastructure/config-versions/last-known-good.js';

/**
 * The platform policy cache across an operator's change.
 *
 * This cache carries `accessMode`, so what is pinned here is an operator's
 * switch taking effect when the panel says it did. The webhook calls
 * `invalidate()`, and a read already in flight at that moment may have reached
 * the panel BEFORE the change committed. If a later caller may join that read,
 * or the read may still store its answer when it lands, the old mode keeps
 * being enforced for up to another minute — while the panel has already
 * recorded the event as delivered, so there is nothing left to re-fire.
 *
 * Every upstream here answers only when the test says so, which is what lets
 * each case choose the order in which overlapping reads settle.
 */

const BEFORE_CHANGE: PlatformPolicyShape = {
  accessMode: 'PUBLIC',
  rulesRequired: false,
  rulesLink: null,
  channelRequired: false,
  channelLink: null,
  defaultCurrency: 'USD',
};

const AFTER_CHANGE: PlatformPolicyShape = { ...BEFORE_CHANGE, accessMode: 'RESTRICTED' };

function handAnswered() {
  const calls: Array<{
    resolve: (value: PlatformPolicyShape) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const fn = vi.fn(
    () =>
      new Promise<PlatformPolicyShape>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  const call = (index: number) => {
    const pending = calls[index];
    if (pending === undefined) throw new Error(`upstream call #${index} was never made`);
    return pending;
  };
  return {
    fn,
    answer: (index: number, value: PlatformPolicyShape): void => call(index).resolve(value),
    fail: (index: number, reason: unknown): void => call(index).reject(reason),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PolicyCache across invalidate()', () => {
  it('a get() after invalidate() does not join the fetch that started before it', async () => {
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn);

    const beforeChange = cache.get();
    cache.invalidate();
    const afterChange = cache.get();

    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(0, BEFORE_CHANGE);
    upstream.answer(1, AFTER_CHANGE);
    expect(await beforeChange).toEqual(BEFORE_CHANGE);
    expect(await afterChange).toEqual(AFTER_CHANGE);
  });

  it('a fetch begun before invalidate() does not overwrite the policy fetched after it', async () => {
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn);

    const beforeChange = cache.get();
    cache.invalidate();
    const afterChange = cache.get();
    upstream.answer(1, AFTER_CHANGE);
    expect(await afterChange).toEqual(AFTER_CHANGE);

    upstream.answer(0, BEFORE_CHANGE); // the old read lands last
    await beforeChange;

    expect(await cache.get()).toEqual(AFTER_CHANGE);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it('a fetch begun before invalidate() that lands with nobody else asking is not kept', async () => {
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn);

    const beforeChange = cache.get();
    cache.invalidate();
    upstream.answer(0, BEFORE_CHANGE);
    await beforeChange;

    const next = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, AFTER_CHANGE);
    expect(await next).toEqual(AFTER_CHANGE);
  });

  it('a fetch begun before invalidate() does not free the slot of the fetch started after it', async () => {
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn);

    const beforeChange = cache.get();
    cache.invalidate();
    const afterChange = cache.get(); // still in flight
    upstream.answer(0, BEFORE_CHANGE);
    await beforeChange;

    // Single-flight still holds: this joins the fetch already on its way.
    const joined = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, AFTER_CHANGE);
    expect(await joined).toEqual(AFTER_CHANGE);
    expect(await afterChange).toEqual(AFTER_CHANGE);
  });

  it('a failed fetch begun before invalidate() does not extend the policy fetched after it', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn, 60_000);

    const beforeChange = cache.get();
    cache.invalidate();
    const afterChange = cache.get();
    upstream.answer(1, AFTER_CHANGE);
    await afterChange;

    now += 50_000;
    upstream.fail(0, new Error('panel down'));
    // Its own caller still gets a usable answer: the policy read after it.
    expect(await beforeChange).toEqual(AFTER_CHANGE);

    // The TTL runs from when the policy was actually read, not from the failure.
    now += 11_000;
    const next = cache.get();
    expect(upstream.fn).toHaveBeenCalledTimes(3);
    upstream.answer(2, AFTER_CHANGE);
    expect(await next).toEqual(AFTER_CHANGE);
  });
});

/**
 * `invalidatePolicyCache()` — what the bot's `/invalidate-policy` route calls.
 *
 * `getPolicyCache(client)` CREATES the singleton on first use, bound to the
 * client it is handed, and every later caller gets that same instance whatever
 * client they pass. The route has no client to hand it, so
 * `getPolicyCache(null).invalidate()` there would, in a bot that has not read
 * the policy yet, bind the cache to nothing for the life of the process.
 */
describe('invalidatePolicyCache()', () => {
  afterEach(() => {
    setPolicyCache(null);
  });

  it('drops the policy the process-wide cache holds', async () => {
    const upstream = vi.fn(async () => BEFORE_CHANGE);
    const cache = new PolicyCache(upstream);
    setPolicyCache(cache);
    await cache.get();
    await cache.get();
    expect(upstream).toHaveBeenCalledTimes(1);

    invalidatePolicyCache();

    await cache.get();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no cache exists yet, and creates none', async () => {
    setPolicyCache(null);

    invalidatePolicyCache();

    // The first real read binds the cache to the client it names. Had the call
    // above created one with no client, this would be the PUBLIC fallback.
    const getPlatformPolicy = vi.fn(async () => AFTER_CHANGE);
    const client = { system: { getPlatformPolicy } } as unknown as AdminClient;
    expect(await getPolicyCache(client).get()).toEqual(AFTER_CHANGE);
    expect(getPlatformPolicy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The stand-in PUBLIC policy during a panel outage with nothing cached yet.
 *
 * It used to be handed out and forgotten, so every read in such an outage went
 * upstream again and waited out the transport timeout. The channel gate reads the
 * policy in front of every bot update, and the bot handles updates one at a time —
 * each button press would stall for the full timeout. A second failure in a row now
 * keeps answering the stand-in for 30 seconds; a single failure is retried at
 * once, so one blip after boot or an invalidation does not open the gates for long.
 */
const LIVE: PlatformPolicyShape = {
  accessMode: 'PUBLIC',
  rulesRequired: false,
  rulesLink: null,
  channelRequired: true,
  channelLink: 'https://t.me/rezeis_news',
  defaultCurrency: 'RUB',
};

describe('PolicyCache with the panel down and nothing cached', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries one failure at once, then answers the stand-in without asking until the window passes', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<() => Promise<PlatformPolicyShape>>().mockRejectedValue(new Error('ECONNREFUSED'));
    const cache = new PolicyCache(fetchFn);

    expect((await cache.get())._isFallback).toBe(true);
    expect((await cache.get())._isFallback).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    expect((await cache.get())._isFallback).toBe(true);
    expect((await cache.get())._isFallback).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // Thirty seconds, written out: importing the constant would pin whatever it held.
    vi.advanceTimersByTime(29_999);
    expect((await cache.get())._isFallback).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect((await cache.get())._isFallback).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not open the window on a single blip: the next read reaches the panel', async () => {
    const fetchFn = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(LIVE);
    const cache = new PolicyCache(fetchFn);

    expect((await cache.get())._isFallback).toBe(true);
    expect(await cache.get()).toEqual(LIVE);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('picks the panel up again on the first read after the window', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<() => Promise<PlatformPolicyShape>>().mockRejectedValue(new Error('ECONNREFUSED'));
    const cache = new PolicyCache(fetchFn);
    await cache.get();
    await cache.get();

    fetchFn.mockResolvedValue(LIVE);
    expect((await cache.get())._isFallback).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    expect(await cache.get()).toEqual(LIVE);
    expect(await cache.get()).toEqual(LIVE);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('forgets the stand-in when the operator changes the policy', async () => {
    const fetchFn = vi.fn<() => Promise<PlatformPolicyShape>>().mockRejectedValue(new Error('ECONNREFUSED'));
    const cache = new PolicyCache(fetchFn);
    await cache.get();
    await cache.get();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    fetchFn.mockResolvedValue(LIVE);
    cache.invalidate();
    expect(await cache.get()).toEqual(LIVE);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('reads an answer that is not an object as a failed read, never as the policy', async () => {
    const fetchFn = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockResolvedValueOnce(null as unknown as PlatformPolicyShape)
      .mockResolvedValueOnce('<html>502</html>' as unknown as PlatformPolicyShape)
      .mockResolvedValue(LIVE);
    const cache = new PolicyCache(fetchFn);

    expect((await cache.get())._isFallback).toBe(true);
    expect(cache.peek()).toBeNull();
    // Two bad answers in a row count as two failures: the stand-in window opens.
    expect((await cache.get())._isFallback).toBe(true);
    expect((await cache.get())._isFallback).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known policy when the panel later answers something that is not an object', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockResolvedValueOnce(LIVE)
      .mockResolvedValue(null as unknown as PlatformPolicyShape);
    const cache = new PolicyCache(fetchFn, 1_000);
    expect(await cache.get()).toEqual(LIVE);

    vi.advanceTimersByTime(1_001);
    expect(await cache.get()).toEqual(LIVE);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(await cache.get()).toEqual(LIVE);
    expect(cache.peek()).toEqual(LIVE);
  });

  it('starts the failure count over after an invalidation', async () => {
    const fetchFn = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(LIVE);
    const cache = new PolicyCache(fetchFn);
    expect((await cache.get())._isFallback).toBe(true);

    cache.invalidate();
    // The first failure since the change: retried at once, not the second in a row.
    expect((await cache.get())._isFallback).toBe(true);
    expect(await cache.get()).toEqual(LIVE);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('still serves the last known policy, not the stand-in, when the panel drops later', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<() => Promise<PlatformPolicyShape>>().mockResolvedValueOnce(LIVE);
    const cache = new PolicyCache(fetchFn, 1_000);
    expect(await cache.get()).toEqual(LIVE);

    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    vi.advanceTimersByTime(1_001);
    expect(await cache.get()).toEqual(LIVE);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // The failed refresh restarted the TTL: the next reads do not go upstream again
    // one after another for the length of the outage.
    expect(await cache.get()).toEqual(LIVE);
    expect(await cache.get()).toEqual(LIVE);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not count a failed read begun before an invalidation toward the window', async () => {
    let rejectStale: (err: Error) => void = () => undefined;
    const fetchFn = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockImplementationOnce(
        () =>
          new Promise<PlatformPolicyShape>((_resolve, reject) => {
            rejectStale = reject;
          }),
      )
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(LIVE);
    const cache = new PolicyCache(fetchFn);

    const stale = cache.get();
    cache.invalidate();
    rejectStale(new Error('ECONNREFUSED'));
    expect((await stale)._isFallback).toBe(true);

    // One failure of its own after the operator's change: retried at once. Had the
    // read from before the change counted too, this would be the second in a row.
    expect((await cache.get())._isFallback).toBe(true);
    expect(await cache.get()).toEqual(LIVE);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

/**
 * A stale policy is answered at once and refreshed in the background.
 *
 * Every minute the TTL ran out, the next reader waited for the panel — and with the
 * gate in front of every bot update, that reader held up everyone queued behind it
 * whenever the panel was slow. Only a MISSING policy is still waited for, so an
 * operator's change applies on the very next read after the invalidation.
 */
describe('PolicyCache with a stale policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers the stale policy at once while one refresh runs', async () => {
    vi.useFakeTimers();
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn, 1_000);
    const first = cache.get();
    upstream.answer(0, BEFORE_CHANGE);
    expect(await first).toEqual(BEFORE_CHANGE);

    vi.advanceTimersByTime(1_001);
    // The refresh is still unanswered; the reader is not held up by it.
    expect(await cache.get()).toEqual(BEFORE_CHANGE);
    expect(await cache.get()).toEqual(BEFORE_CHANGE);
    expect(upstream.fn).toHaveBeenCalledTimes(2);

    upstream.answer(1, AFTER_CHANGE);
    for (let i = 0; i < 20 && cache.peek() !== AFTER_CHANGE; i += 1) await Promise.resolve();
    expect(await cache.get()).toEqual(AFTER_CHANGE);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it('still waits for the panel after an invalidation, so the change applies on the next read', async () => {
    const upstream = handAnswered();
    const cache = new PolicyCache(upstream.fn);
    const first = cache.get();
    upstream.answer(0, BEFORE_CHANGE);
    await first;

    cache.invalidate();
    const next = cache.get();
    upstream.answer(1, AFTER_CHANGE);
    expect(await next).toEqual(AFTER_CHANGE);
  });
});

/**
 * With the panel unreachable: the LAST KNOWN policy, never "open to everybody"
 * in its place — the owner's rule of 24.09.2026 (W8 report D5). A restart
 * during an outage used to come back on the PUBLIC stand-in: the invite mode,
 * the channel gate and the rules gate all off, in the bot and in the cabinet,
 * until the panel returned.
 */
describe('PolicyCache and the last known policy (W8 report D5)', () => {
  const INVITED: PlatformPolicyShape = {
    accessMode: 'INVITED',
    rulesRequired: true,
    rulesLink: 'https://example.com/rules',
    channelRequired: true,
    channelLink: 'https://t.me/operator_news',
    defaultCurrency: 'RUB',
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A store holding `saved` (or nothing), recording every save. */
  function savedCopy(saved: PlatformPolicyShape | null) {
    const saves: unknown[] = [];
    let record: LastKnownGood<Record<string, unknown>> | null =
      saved === null
        ? null
        : { shape: 1, savedAt: 1_700_000_000_000, hash: configVersionOf(saved), payload: { ...saved } };
    const store: LastKnownGoodStorePort = {
      load: vi.fn(async () => record) as LastKnownGoodStorePort['load'],
      save: vi.fn(async (_group: unknown, payload: unknown) => {
        saves.push(payload);
        record = { shape: 1, savedAt: 2, hash: configVersionOf(payload), payload: payload as Record<string, unknown> };
      }) as LastKnownGoodStorePort['save'],
    };
    return { store, saves };
  }

  /** What `promise` settles to — or a failure, if it needs any time to pass to settle. */
  async function answeredWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
    const outcome: { settled: boolean; value?: T } = { settled: false };
    void promise.then((value) => {
      outcome.settled = true;
      outcome.value = value;
    });
    for (let turn = 0; turn < 50 && !outcome.settled; turn += 1) await Promise.resolve();
    if (!outcome.settled) throw new Error('the read waited on the panel');
    return outcome.value as T;
  }

  it('a restart with the panel down serves the saved policy, not the PUBLIC stand-in', async () => {
    const { store } = savedCopy(INVITED);
    const cache = new PolicyCache(
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      { lastKnownGood: store },
    );

    const policy = await cache.get();

    expect(policy).toEqual(INVITED);
    expect(policy._isFallback).toBeUndefined();
    expect(cache.heldVersion()).toBe(configVersionOf(INVITED));
    // Held from here on, as a policy gone stale: the next read does not ask Redis again.
    expect(await cache.get()).toEqual(INVITED);
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('a restart with the panel hanging serves the saved policy at once', async () => {
    vi.useFakeTimers();
    const { store } = savedCopy(INVITED);
    const cache = new PolicyCache(() => new Promise<never>(() => undefined), { lastKnownGood: store });

    expect(await answeredWithoutWaiting(cache.get())).toEqual(INVITED);
  });

  it('answers the PUBLIC stand-in only when no copy has ever existed', async () => {
    const { store } = savedCopy(null);
    const cache = new PolicyCache(
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      { lastKnownGood: store },
    );

    expect((await cache.get())._isFallback).toBe(true);
    expect(cache.heldVersion()).toBeNull();
  });

  it('saves every policy the panel answers — but not one an invalidation overtook', async () => {
    const upstream = handAnswered();
    const { store, saves } = savedCopy(null);
    const cache = new PolicyCache(upstream.fn, { lastKnownGood: store });

    const beforeChange = cache.get();
    cache.invalidate();
    const afterChange = cache.get();
    upstream.answer(1, AFTER_CHANGE);
    await afterChange;
    upstream.answer(0, BEFORE_CHANGE); // the pre-change read lands last
    await beforeChange;

    // What a restart during an outage serves must be the policy after the change.
    expect(saves).toEqual([AFTER_CHANGE]);
  });

  it('after an invalidation, a panel that fails leaves the policy the cabinet had — not PUBLIC', async () => {
    const fetchFn = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockResolvedValueOnce(INVITED)
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    const cache = new PolicyCache(fetchFn);
    expect(await cache.get()).toEqual(INVITED);

    cache.invalidate();

    const policy = await cache.get();
    expect(policy).toEqual(INVITED);
    expect(policy._isFallback).toBeUndefined();
  });

  it('after an invalidation, a hung panel holds one read the budget — then the kept policy, and no read after it waits', async () => {
    vi.useFakeTimers();
    let hanging = false;
    const fetchFn = vi.fn(() =>
      hanging ? new Promise<PlatformPolicyShape>(() => undefined) : Promise.resolve(INVITED),
    );
    const cache = new PolicyCache(fetchFn, { waitBudgetMs: 1_000 });
    expect(await cache.get()).toEqual(INVITED);
    hanging = true;
    cache.invalidate();

    const first = cache.get();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual(INVITED);

    expect(await answeredWithoutWaiting(cache.get())).toEqual(INVITED);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('holds the version of the policy it holds, for the version poll', async () => {
    const cache = new PolicyCache(async () => INVITED);
    expect(cache.heldVersion()).toBeNull();
    await cache.get();
    expect(cache.heldVersion()).toBe(configVersionOf(INVITED));
  });
});
