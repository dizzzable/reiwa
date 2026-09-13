import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformPolicyShape } from '../../../src/infrastructure/admin-client/namespaces/system.js';
import { PolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';

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
