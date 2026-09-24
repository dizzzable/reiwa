import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import {
  createBrandingRouter,
  getCustomEmojiPacks,
  heldCustomEmojiPacksVersion,
  resetBrandingCache,
  resetCustomEmojiPacksCache,
} from '../../src/api/routes/branding.js';
import { configVersionOf } from '../../src/infrastructure/config-versions/config-version.js';
import type {
  LastKnownGood,
  LastKnownGoodStorePort,
} from '../../src/infrastructure/config-versions/last-known-good.js';

/**
 * The cabinet feed's custom emoji packs (W8 report D8).
 *
 * The route used to fetch on every request of a stale window — each on its own,
 * no single flight — and to forget a failure, so with the panel hanging every
 * request waited out the transport's ten seconds and answered `[]`. Now: one
 * read at a time, a failure remembered for the TTL, stale-while-revalidate, and
 * a restart during an outage serves the packs saved in reiwa's Redis.
 */

const PACKS = [{ slug: 'cats', emojis: [{ slug: 'cat', url: '/uploads/emoji/cat.png' }] }];

function savedCopy(saved: unknown[] | null) {
  const saves: unknown[] = [];
  const record: LastKnownGood<unknown[]> | null =
    saved === null ? null : { shape: 1, savedAt: 1, hash: configVersionOf(saved), payload: saved };
  const store: LastKnownGoodStorePort = {
    load: vi.fn(async () => record) as LastKnownGoodStorePort['load'],
    save: vi.fn(async (_group: unknown, payload: unknown) => {
      saves.push(payload);
    }) as LastKnownGoodStorePort['save'],
  };
  return { store, saves };
}

function client(getCustomEmojiPacks: () => Promise<unknown>) {
  return { branding: { getCustomEmojiPacks } } as never;
}

async function request(app: express.Express): Promise<{ body: unknown; cacheControl: string | undefined }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/v1/custom-emoji/packs' }, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          res.on('end', () => resolve({ body: JSON.parse(text) as unknown, cacheControl: res.headers['cache-control'] }));
        })
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('custom emoji packs (W8 report D8)', () => {
  beforeEach(() => {
    resetBrandingCache();
    // A router built without a store leaves the packs with none: no case
    // inherits the saved copy of the one before it.
    createBrandingRouter({ adminClient: null });
  });
  afterEach(() => {
    resetBrandingCache();
    vi.restoreAllMocks();
  });

  it('concurrent requests share one panel read', async () => {
    let answer!: (packs: unknown) => void;
    const fetchPacks = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    );
    const adminClient = client(fetchPacks);

    const reads = [getCustomEmojiPacks(adminClient), getCustomEmojiPacks(adminClient), getCustomEmojiPacks(adminClient)];
    expect(fetchPacks).toHaveBeenCalledTimes(1);
    answer(PACKS);
    for (const read of await Promise.all(reads)) expect(read.body).toEqual(PACKS);
  });

  it('remembers a failure for the TTL: a dead panel is asked once, not once per request', async () => {
    const fetchPacks = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const adminClient = client(fetchPacks);

    for (let request = 0; request < 5; request += 1) {
      expect((await getCustomEmojiPacks(adminClient)).body).toEqual([]);
    }
    expect(fetchPacks).toHaveBeenCalledTimes(1);
  });

  it('serves stale packs at once while one refresh runs', async () => {
    let calls = 0;
    let answer!: (packs: unknown) => void;
    const fetchPacks = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(PACKS);
      return new Promise<unknown>((resolve) => {
        answer = resolve;
      });
    });
    const adminClient = client(fetchPacks);
    await getCustomEmojiPacks(adminClient);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);

    expect((await getCustomEmojiPacks(adminClient)).body).toEqual(PACKS);
    expect((await getCustomEmojiPacks(adminClient)).body).toEqual(PACKS);
    expect(fetchPacks).toHaveBeenCalledTimes(2);
    answer([]);
  });

  it('a restart with the panel down serves the saved packs, no-store — and the empty list only with none saved', async () => {
    const saved = savedCopy(PACKS);
    const app = express();
    app.use(
      '/api/v1',
      createBrandingRouter({
        adminClient: client(async () => {
          throw new Error('connect ECONNREFUSED');
        }),
        lastKnownGood: saved.store,
      }),
    );

    const res = await request(app);
    expect(res.body).toEqual(PACKS);
    expect(res.cacheControl).toBe('no-store');
    expect(heldCustomEmojiPacksVersion()).toBe(configVersionOf(PACKS));

    resetCustomEmojiPacksCache();
    const none = express();
    none.use(
      '/api/v1',
      createBrandingRouter({
        adminClient: client(async () => {
          throw new Error('connect ECONNREFUSED');
        }),
        lastKnownGood: savedCopy(null).store,
      }),
    );
    const empty = await request(none);
    expect(empty.body).toEqual([]);
    expect(empty.cacheControl).toBe('no-store');
    expect(heldCustomEmojiPacksVersion()).toBeNull();
  });

  it('saves what the panel answers and serves it with the public cache headers', async () => {
    const saved = savedCopy(null);
    const app = express();
    app.use('/api/v1', createBrandingRouter({ adminClient: client(async () => PACKS), lastKnownGood: saved.store }));

    const res = await request(app);

    expect(res.body).toEqual(PACKS);
    expect(res.cacheControl).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(saved.saves).toEqual([PACKS]);
  });

  it('a read begun before a reset neither lands in the cache nor in the saved copy', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const fetchPacks = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          answers.push(resolve);
        }),
    );
    const saved = savedCopy(null);
    // Built for its store: the router is what hands the packs cache its saved copy.
    createBrandingRouter({ adminClient: client(fetchPacks), lastKnownGood: saved.store });
    const adminClient = client(fetchPacks);
    const SAVED_PACKS = [...PACKS, { slug: 'dogs', emojis: [] }];

    const beforeSave = getCustomEmojiPacks(adminClient);
    resetCustomEmojiPacksCache();
    const afterSave = getCustomEmojiPacks(adminClient);
    (answers[1] as (value: unknown) => void)(SAVED_PACKS);
    await afterSave;
    (answers[0] as (value: unknown) => void)(PACKS); // the old read lands last
    await beforeSave;

    expect((await getCustomEmojiPacks(adminClient)).body).toEqual(SAVED_PACKS);
    expect(saved.saves).toEqual([SAVED_PACKS]);
  });
});
