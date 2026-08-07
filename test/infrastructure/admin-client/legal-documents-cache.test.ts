import { describe, expect, it } from 'vitest';

import { LegalDocumentsCache } from '../../../src/infrastructure/admin-client/legal-documents-cache.js';
import type { LegalDocument } from '../../../src/infrastructure/admin-client/namespaces/legal-documents.js';

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
