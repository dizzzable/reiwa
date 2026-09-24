import { describe, expect, it, vi } from 'vitest';

import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import type { LastKnownGoodStorePort } from '../../../src/infrastructure/config-versions/last-known-good.js';
import {
  CONNECT_PAGE_LKG,
  ConnectPageVersionTracker,
  RedisConnectPageSnapshot,
  type ConnectPageSnapshotStore,
} from '../../../src/infrastructure/public-config/redis-connect-page-snapshot.js';

/**
 * The connect screen's saved catalog, now in the shared last-known-good store,
 * and the version of the catalog the screen holds — for the version poll.
 */

const CATALOG = { platforms: { ios: { apps: [{ id: 'happ' }] } } };

describe('RedisConnectPageSnapshot', () => {
  it('keeps catalogs in the connect-page group, and only something that looks like one', async () => {
    const save = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ shape: 1, savedAt: 1, hash: configVersionOf(CATALOG), payload: CATALOG }));
    const snapshot = new RedisConnectPageSnapshot({
      redis: {} as never,
      store: { load, save } as unknown as LastKnownGoodStorePort,
    });

    await snapshot.save(CATALOG);
    await snapshot.save({ notACatalog: true });
    await snapshot.save(null);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(CONNECT_PAGE_LKG, CATALOG);
    expect(await snapshot.load()).toEqual(CATALOG);
    expect(CONNECT_PAGE_LKG.legacyKey).toBe('reiwa:connect-page:last-known-good');
  });
});

describe('ConnectPageVersionTracker', () => {
  function inner(copy: unknown | null): ConnectPageSnapshotStore & { saved: unknown[] } {
    const saved: unknown[] = [];
    return {
      saved,
      load: async () => copy,
      save: async (payload: unknown) => {
        saved.push(payload);
      },
    };
  }

  it('holds the version of every catalog the screen caches, from the save it goes through first', async () => {
    const store = inner(null);
    const tracker = new ConnectPageVersionTracker(store);
    expect(tracker.heldVersion()).toBeNull();

    const saving = tracker.save(CATALOG);
    // Taken on the call, not after Redis answers: the route caches the catalog on this same turn.
    expect(tracker.heldVersion()).toBe(configVersionOf(CATALOG));
    await saving;
    expect(store.saved).toEqual([CATALOG]);
  });

  it('holds the saved copy’s version when a cold start serves it', async () => {
    const tracker = new ConnectPageVersionTracker(inner(CATALOG));
    expect(await tracker.load()).toEqual(CATALOG);
    expect(tracker.heldVersion()).toBe(configVersionOf(CATALOG));
  });

  it('holds nothing after forget() — the reset beside the route’s own', async () => {
    const tracker = new ConnectPageVersionTracker(inner(null));
    await tracker.save(CATALOG);
    tracker.forget();
    expect(tracker.heldVersion()).toBeNull();
  });
});
