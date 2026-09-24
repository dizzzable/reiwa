import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegalDocumentsCache } from '../../../src/infrastructure/admin-client/legal-documents-cache.js';
import type { LegalDocument } from '../../../src/infrastructure/admin-client/namespaces/legal-documents.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';

/**
 * The bot's cache for legal documents.
 *
 * This exists for a reason that is not "fewer requests". `AdminTransport` runs
 * ONE 50-connection pool for everything the bot does — payments, subscriptions,
 * support — and a call made without a cache has no timeout of its own, only the
 * transport's 10s headers timeout. While the panel is slow or down, every tap
 * on the rules screen parks a connection for ten seconds in the pool that
 * checkout also needs, and fifty concurrent taps drain it.
 *
 * So the three properties below are each load-bearing:
 *   - the TTL bounds how often a tap can reach upstream at all;
 *   - single-flight means N simultaneous taps cost ONE request, not N;
 *   - last-known-good means an outage answers instantly instead of waiting out
 *     the timeout on every tap.
 *
 * The cabinet deliberately has none of this — an operator's edit must be the
 * wording the next visitor agrees to. The bot only asks "is there anything to
 * link to", never renders the text, so a minute of staleness costs a wrong
 * button and nothing else.
 */

const AGREEMENT: LegalDocument = { key: 'USER_AGREEMENT', title: 'Соглашение', body: 'Текст' };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('LegalDocumentsCache', () => {
  it('serves a second read from cache instead of calling upstream again', async () => {
    let calls = 0;
    const cache = new LegalDocumentsCache(async () => {
      calls += 1;
      return [AGREEMENT];
    });

    await cache.get('ru');
    await cache.get('ru');

    expect(calls).toBe(1);
  });

  it('collapses simultaneous reads into one upstream call', async () => {
    // The property that keeps a burst of taps from taking a connection each.
    let calls = 0;
    const gate = deferred<readonly LegalDocument[]>();
    const cache = new LegalDocumentsCache(async () => {
      calls += 1;
      return gate.promise;
    });

    const inFlight = [cache.get('ru'), cache.get('ru'), cache.get('ru')];
    gate.resolve([AGREEMENT]);
    const results = await Promise.all(inFlight);

    expect(calls).toBe(1);
    expect(results.every((r) => r.length === 1)).toBe(true);
  });

  it('caches each locale separately', async () => {
    const seen: string[] = [];
    const cache = new LegalDocumentsCache(async (locale) => {
      seen.push(locale);
      return [];
    });

    await cache.get('ru');
    await cache.get('en');
    await cache.get('ru');

    expect(seen).toEqual(['ru', 'en']);
  });

  it('answers an outage with the last good value instead of failing', async () => {
    let shouldFail = false;
    const cache = new LegalDocumentsCache(async () => {
      if (shouldFail) throw new Error('panel down');
      return [AGREEMENT];
    }, 0);

    await cache.get('ru');
    shouldFail = true;

    expect(await cache.get('ru')).toEqual([AGREEMENT]);
  });

  it('answers an outage with no prior value as "no documents", not by throwing', async () => {
    // The caller reads an empty list as "nothing enabled" and falls back to the
    // legacy rules link. An older link is a better outcome than a dead screen.
    const cache = new LegalDocumentsCache(async () => {
      throw new Error('panel down');
    });

    expect(await cache.get('ru')).toEqual([]);
  });

  it('refetches once the entry is explicitly invalidated', async () => {
    // Wired to the operator-edit webhook: switching a document on must change
    // which link the rules screen offers without waiting out the TTL.
    let calls = 0;
    const cache = new LegalDocumentsCache(async () => {
      calls += 1;
      return [];
    });

    await cache.get('ru');
    cache.invalidate();
    await cache.get('ru');

    expect(calls).toBe(2);
  });
});

/**
 * The same cache across the operator-edit webhook.
 *
 * A read already in flight when `invalidate()` runs may have reached the panel
 * BEFORE the document was switched on. If a later tap may join that read, or
 * the read may still store its answer when it lands, the rules screen keeps
 * offering the old link for another whole TTL — with the webhook already spent.
 * Every upstream here answers only when the test says so.
 */
describe('LegalDocumentsCache across invalidate()', () => {
  const NONE: readonly LegalDocument[] = [];
  const SWITCHED_ON: readonly LegalDocument[] = [AGREEMENT];

  function handAnswered() {
    const calls: Array<{
      resolve: (value: readonly LegalDocument[]) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const fn = vi.fn(
      (_locale: string) =>
        new Promise<readonly LegalDocument[]>((resolve, reject) => {
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
      answer: (index: number, value: readonly LegalDocument[]): void => call(index).resolve(value),
      fail: (index: number, reason: unknown): void => call(index).reject(reason),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a get() after invalidate() does not join the fetch that started before it', async () => {
    const upstream = handAnswered();
    const cache = new LegalDocumentsCache(upstream.fn);

    const beforeEdit = cache.get('ru');
    cache.invalidate();
    const afterEdit = cache.get('ru');

    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(0, NONE);
    upstream.answer(1, SWITCHED_ON);
    expect(await beforeEdit).toEqual(NONE);
    expect(await afterEdit).toEqual(SWITCHED_ON);
  });

  it('a fetch begun before invalidate() does not overwrite the documents fetched after it', async () => {
    const upstream = handAnswered();
    const cache = new LegalDocumentsCache(upstream.fn);

    const beforeEdit = cache.get('ru');
    cache.invalidate();
    const afterEdit = cache.get('ru');
    upstream.answer(1, SWITCHED_ON);
    expect(await afterEdit).toEqual(SWITCHED_ON);

    upstream.answer(0, NONE); // the old read lands last
    await beforeEdit;

    expect(await cache.get('ru')).toEqual(SWITCHED_ON);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it('a fetch begun before invalidate() that lands with nobody else asking is not kept', async () => {
    const upstream = handAnswered();
    const cache = new LegalDocumentsCache(upstream.fn);

    const beforeEdit = cache.get('ru');
    cache.invalidate();
    upstream.answer(0, NONE);
    await beforeEdit;

    const next = cache.get('ru');
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SWITCHED_ON);
    expect(await next).toEqual(SWITCHED_ON);
  });

  it('a fetch begun before invalidate() does not free the slot of the fetch started after it', async () => {
    const upstream = handAnswered();
    const cache = new LegalDocumentsCache(upstream.fn);

    const beforeEdit = cache.get('ru');
    cache.invalidate();
    const afterEdit = cache.get('ru'); // still in flight
    upstream.answer(0, NONE);
    await beforeEdit;

    // Single-flight still holds: this joins the fetch already on its way.
    const joined = cache.get('ru');
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, SWITCHED_ON);
    expect(await joined).toEqual(SWITCHED_ON);
    expect(await afterEdit).toEqual(SWITCHED_ON);
  });

  it('a failed fetch begun before invalidate() does not extend the documents fetched after it', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const upstream = handAnswered();
    const cache = new LegalDocumentsCache(upstream.fn, 60_000);

    const beforeEdit = cache.get('ru');
    cache.invalidate();
    const afterEdit = cache.get('ru');
    upstream.answer(1, SWITCHED_ON);
    await afterEdit;

    now += 50_000;
    upstream.fail(0, new Error('panel down'));
    // Its own caller still gets a usable answer: the documents read after it.
    expect(await beforeEdit).toEqual(SWITCHED_ON);

    // The TTL runs from when the documents were actually read, not from the failure.
    now += 11_000;
    const next = cache.get('ru');
    expect(upstream.fn).toHaveBeenCalledTimes(3);
    upstream.answer(2, SWITCHED_ON);
    expect(await next).toEqual(SWITCHED_ON);
  });
});

/**
 * No tap waits on a panel that hangs (W8 report D1): the rules screen reads
 * these in the bot, which handles updates one at a time. A locale held is
 * answered at once, whatever its age, while one refresh runs behind it; only a
 * locale never read waits, and only the budget.
 */
describe('LegalDocumentsCache with a panel that hangs (W8 report D1)', () => {
  const SWITCHED_ON: readonly LegalDocument[] = [AGREEMENT];

  afterEach(() => {
    vi.useRealTimers();
  });

  /** What `promise` settles to — or a failure, if it needs any time to pass to settle. */
  async function answeredWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
    const outcome: { settled: boolean; value?: T } = { settled: false };
    void promise.then((value) => {
      outcome.settled = true;
      outcome.value = value;
    });
    for (let turn = 0; turn < 50 && !outcome.settled; turn += 1) await Promise.resolve();
    if (!outcome.settled) throw new Error('the tap waited on the panel');
    return outcome.value as T;
  }

  it('past the TTL, every tap is answered from what is held while one read hangs', async () => {
    vi.useFakeTimers();
    let hanging = false;
    const fetchFn = vi.fn(() =>
      hanging ? new Promise<readonly LegalDocument[]>(() => undefined) : Promise.resolve(SWITCHED_ON),
    );
    const cache = new LegalDocumentsCache(fetchFn, 60_000);
    await cache.get('ru');
    hanging = true;
    vi.advanceTimersByTime(60_000);

    for (let tap = 0; tap < 20; tap += 1) {
      expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual(SWITCHED_ON);
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('after an operator’s edit, taps are answered from what was held while the edit’s read hangs', async () => {
    vi.useFakeTimers();
    let hanging = false;
    const fetchFn = vi.fn(() =>
      hanging ? new Promise<readonly LegalDocument[]>(() => undefined) : Promise.resolve(SWITCHED_ON),
    );
    const cache = new LegalDocumentsCache(fetchFn);
    await cache.get('ru');
    hanging = true;

    cache.invalidate();
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual(SWITCHED_ON);
    expect(await answeredWithoutWaiting(cache.get('ru'))).toEqual(SWITCHED_ON);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a locale never read waits the budget once, then "no documents" — the taps after it do not wait', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<readonly LegalDocument[]>(() => undefined));
    const cache = new LegalDocumentsCache(fetchFn, 60_000, 1_000);

    const first = cache.get('en');
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual([]);

    expect(await answeredWithoutWaiting(cache.get('en'))).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('an edit lands behind the tap that started its read', async () => {
    const upstream = deferred<readonly LegalDocument[]>();
    let calls = 0;
    const cache = new LegalDocumentsCache(async () => {
      calls += 1;
      return calls === 1 ? [] : upstream.promise;
    });
    expect(await cache.get('ru')).toEqual([]);

    cache.invalidate();
    expect(await cache.get('ru')).toEqual([]);
    upstream.resolve(SWITCHED_ON);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await cache.get('ru')).toEqual(SWITCHED_ON);
  });
});

/** The version the poll compares with the panel's, per language the panel versions. */
describe('LegalDocumentsCache.heldVersion()', () => {
  it('is the version of what is held for a locale, null for one never read, and refreshHeld() re-reads what is held', async () => {
    const answers: Record<string, readonly LegalDocument[]> = { ru: [AGREEMENT], en: [] };
    const fetchFn = vi.fn(async (locale: string) => answers[locale] ?? []);
    const cache = new LegalDocumentsCache(fetchFn);
    expect(cache.heldVersion('ru')).toBeNull();

    await cache.get('ru');
    expect(cache.heldVersion('ru')).toBe(configVersionOf([AGREEMENT]));
    expect(cache.heldVersion('en')).toBeNull();

    answers['ru'] = [];
    cache.refreshHeld();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(cache.heldVersion('ru')).toBe(configVersionOf([]));
    // Only what is held: a locale never read is not read by it.
    expect(fetchFn.mock.calls.map(([locale]) => locale)).toEqual(['ru', 'ru']);
  });
});
