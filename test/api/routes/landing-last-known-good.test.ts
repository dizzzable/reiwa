import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import {
  createLandingRouter,
  heldLandingVersion,
  resetLandingCache,
} from '../../../src/api/routes/landing.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import type {
  LastKnownGood,
  LastKnownGoodStorePort,
} from '../../../src/infrastructure/config-versions/last-known-good.js';

/**
 * The landing through a panel outage (W8 report D2).
 *
 * A restart during an outage used to serve `{ enabled: false }` — every web
 * visitor sent to sign-in — and with public cache headers, so a visitor who
 * loaded the page in the blip skipped the landing on their next visit too. Now
 * the last landing the panel served comes back from reiwa's Redis, "disabled"
 * means the panel said so, and nothing that is not the panel's own answer is
 * cached by the browser.
 */

const PUBLISHED = {
  schemaVersion: 1,
  enabled: true,
  defaultLocale: 'ru',
  meta: { title: { ru: 'Операторский лендинг' } },
  sections: [],
};

function savedCopy(saved: Record<string, unknown> | null) {
  const saves: Array<{ payload: unknown; hash: string | undefined }> = [];
  const record: LastKnownGood<Record<string, unknown>> | null =
    saved === null ? null : { shape: 1, savedAt: 1, hash: configVersionOf(saved), payload: saved };
  const store: LastKnownGoodStorePort = {
    load: vi.fn(async () => record) as LastKnownGoodStorePort['load'],
    save: vi.fn(async (_group: unknown, payload: unknown, hash?: string) => {
      saves.push({ payload, hash });
      return 'saved' as const;
    }) as LastKnownGoodStorePort['save'],
  };
  return { store, saves };
}

function makeApp(getEffective: () => Promise<unknown>, lastKnownGood: LastKnownGoodStorePort) {
  const app = express();
  app.use('/api/v1', createLandingRouter({ adminClient: { landing: { getEffective } } as never, lastKnownGood }));
  return app;
}

async function get(app: express.Express): Promise<{ status: number; body: unknown; cacheControl: string | undefined }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/v1/landing' }, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text) as unknown,
              cacheControl: res.headers['cache-control'],
            }),
          );
        })
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

const panelDown = async (): Promise<never> => {
  throw new Error('connect ECONNREFUSED');
};

describe('the landing and its last good copy (W8 report D2)', () => {
  beforeEach(() => resetLandingCache());
  afterEach(() => resetLandingCache());

  it('a restart with the panel down serves the last landing the panel published — not "disabled"', async () => {
    const { store } = savedCopy(PUBLISHED);

    const res = await get(makeApp(panelDown, store));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(PUBLISHED);
    // A copy, not the panel's answer: no browser keeps it past the outage.
    expect(res.cacheControl).toBe('no-store');
    expect(heldLandingVersion()).toBe(configVersionOf(PUBLISHED));
  });

  it('with no copy ever saved, the sentinel — served no-store, so the blip is not remembered by the browser', async () => {
    const { store } = savedCopy(null);

    const res = await get(makeApp(panelDown, store));

    expect(res.body).toEqual({ enabled: false });
    expect(res.cacheControl).toBe('no-store');
    expect(heldLandingVersion()).toBeNull();
  });

  it('"disabled" the panel said is the panel’s answer: cached like one, and kept as the copy', async () => {
    const { store, saves } = savedCopy(null);

    const res = await get(makeApp(async () => ({ enabled: false }), store));

    expect(res.body).toEqual({ enabled: false });
    expect(res.cacheControl).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(saves).toEqual([{ payload: { enabled: false }, hash: configVersionOf({ enabled: false }) }]);
  });

  it('saves what the panel publishes, and serves it with the public cache headers', async () => {
    const { store, saves } = savedCopy(null);

    const res = await get(makeApp(async () => PUBLISHED, store));

    expect(res.body).toEqual(PUBLISHED);
    expect(res.cacheControl).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(saves).toEqual([{ payload: PUBLISHED, hash: configVersionOf(PUBLISHED) }]);
  });

  it('keeps serving the landing it had, no-store, when a later read fails', async () => {
    let calls = 0;
    const { store } = savedCopy(null);
    const app = makeApp(async () => {
      calls += 1;
      if (calls === 1) return PUBLISHED;
      throw new Error('connect ECONNREFUSED');
    }, store);
    await get(app);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);

    const res = await get(app);

    expect(res.body).toEqual(PUBLISHED);
    expect(res.cacheControl).toBe('no-store');
    vi.restoreAllMocks();
  });

  it('a read begun before a publish does not save its landing as the copy', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const getEffective = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { store, saves } = savedCopy(null);
    const app = makeApp(getEffective, store);
    const REPUBLISHED = { ...PUBLISHED, meta: { title: { ru: 'После публикации' } } };

    const beforePublish = get(app);
    await vi.waitFor(() => expect(getEffective).toHaveBeenCalledTimes(1));
    resetLandingCache();
    const afterPublish = get(app);
    await vi.waitFor(() => expect(getEffective).toHaveBeenCalledTimes(2));
    (answers[1] as (value: unknown) => void)(REPUBLISHED);
    await afterPublish;
    (answers[0] as (value: unknown) => void)(PUBLISHED); // the old read lands last
    await beforePublish;

    // What a restart during an outage serves must be the landing after the publish.
    expect(saves.map((save) => save.payload)).toEqual([REPUBLISHED]);
  });
});
