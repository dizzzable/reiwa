import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createConnectPageRouter, resetConnectPageCache } from '../../../src/api/routes/connect-page.js';
import { createLandingRouter, heldLandingVersion, resetLandingCache } from '../../../src/api/routes/landing.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import {
  LANDING_LKG,
  LAST_KNOWN_GOOD_RETRY_MS,
  RedisLastKnownGoodStore,
  type LastKnownGoodStorePort,
} from '../../../src/infrastructure/config-versions/last-known-good.js';
import {
  CONNECT_PAGE_LKG,
  ConnectPageVersionTracker,
  RedisConnectPageSnapshot,
} from '../../../src/infrastructure/public-config/redis-connect-page-snapshot.js';

/**
 * `/landing` and `/connect-page` name the version of the body they served in
 * `X-Config-Version`, as `/public-config` does (review R2a-05).
 *
 * A fresh load reads `/landing` before the SPA's version watcher has its first
 * answer, so the read is a plain one — and the service worker answers it from
 * its cache (stale-while-revalidate, 24 h): the landing from before a publish.
 * Without a version on that body the watcher took the old copy for the page's
 * own and never re-read it; the `/` router sent visitors on by the old
 * `enabled`. The header rides on the cached response, so the watcher sees it is
 * older. Set before the 304, so a revalidation updates the stored headers.
 */

const PUBLISHED = { schemaVersion: 1, enabled: true, defaultLocale: 'ru', sections: [] };
const CATALOG = { version: 2, platforms: [], icons: {}, showConnectionKeys: false };

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function noCopy(): LastKnownGoodStorePort {
  return {
    load: vi.fn(async () => null) as LastKnownGoodStorePort['load'],
    save: vi.fn(async () => 'saved' as const) as LastKnownGoodStorePort['save'],
  };
}

/** A Redis double whose GETs fail until `open()`. */
function closedRedis(initial: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial));
  let closed = true;
  return {
    open: () => {
      closed = false;
    },
    redis: {
      get: vi.fn(async (key: string) => {
        if (closed) throw new Error('Command timed out');
        return data.get(key) ?? null;
      }),
      set: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async () => 0),
    },
  };
}

async function recordFor(group: Parameters<RedisLastKnownGoodStore['save']>[0], payload: unknown) {
  const data = new Map<string, string>();
  await new RedisLastKnownGoodStore({
    redis: {
      get: async () => null,
      set: async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      },
      del: async () => 0,
    } as never,
  }).save(group as never, payload as never);
  return Object.fromEntries(data);
}

describe('/landing names its version (review R2a-05)', () => {
  beforeEach(() => resetLandingCache());
  afterEach(() => {
    resetLandingCache();
    vi.restoreAllMocks();
  });

  it('on the 200 and on the 304 — the value /config-versions reports as held', async () => {
    const app = express();
    app.use('/api/v1', createLandingRouter({ adminClient: { landing: { getEffective: async () => PUBLISHED } } as never, lastKnownGood: noCopy() }));
    const { base, close } = await listen(app);
    try {
      const first = await fetch(`${base}/landing`);
      expect(first.headers.get('x-config-version')).toBe(configVersionOf(PUBLISHED));
      expect(heldLandingVersion()).toBe(configVersionOf(PUBLISHED));

      const revalidated = await fetch(`${base}/landing`, { headers: { 'if-none-match': first.headers.get('etag') ?? '' } });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get('x-config-version')).toBe(configVersionOf(PUBLISHED));
    } finally {
      await close();
    }
  });

  it('names nothing for the sentinel no panel said', async () => {
    const app = express();
    app.use(
      '/api/v1',
      createLandingRouter({
        adminClient: {
          landing: {
            getEffective: async () => {
              throw new Error('connect ECONNREFUSED');
            },
          },
        } as never,
        lastKnownGood: noCopy(),
      }),
    );
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/landing`);
      expect(await res.json()).toEqual({ enabled: false });
      expect(res.headers.get('x-config-version')).toBeNull();
    } finally {
      await close();
    }
  });

  it('a Redis blip at a cold start: the sentinel for the store’s pause only — then the saved landing (review R2a-01)', async () => {
    const { redis, open } = closedRedis(await recordFor(LANDING_LKG, PUBLISHED));
    const app = express();
    app.use(
      '/api/v1',
      createLandingRouter({
        adminClient: {
          landing: {
            getEffective: async () => {
              throw new Error('connect ECONNREFUSED');
            },
          },
        } as never,
        lastKnownGood: new RedisLastKnownGoodStore({ redis: redis as never }),
      }),
    );
    const { base, close } = await listen(app);
    try {
      expect(await (await fetch(`${base}/landing`)).json()).toEqual({ enabled: false });
      open();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + LAST_KNOWN_GOOD_RETRY_MS + 1);
      const res = await fetch(`${base}/landing`);
      expect(await res.json()).toEqual(PUBLISHED);
      expect(res.headers.get('x-config-version')).toBe(configVersionOf(PUBLISHED));
    } finally {
      await close();
    }
  });
});

describe('/connect-page names its version (review R2a-05)', () => {
  beforeEach(() => resetConnectPageCache());
  afterEach(() => {
    resetConnectPageCache();
    vi.restoreAllMocks();
  });

  it('on the 200 and on the 304 — the value the version tracker reports as held', async () => {
    const tracker = new ConnectPageVersionTracker({ load: async () => null, save: async () => undefined });
    const app = express();
    app.use('/api/v1', createConnectPageRouter({ connectPage: { getEffective: async () => CATALOG } } as never, tracker));
    const { base, close } = await listen(app);
    try {
      const first = await fetch(`${base}/connect-page`);
      expect(first.headers.get('x-config-version')).toBe(configVersionOf(CATALOG));
      expect(tracker.heldVersion()).toBe(configVersionOf(CATALOG));

      const revalidated = await fetch(`${base}/connect-page`, {
        headers: { 'if-none-match': first.headers.get('etag') ?? '' },
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get('x-config-version')).toBe(configVersionOf(CATALOG));
    } finally {
      await close();
    }
  });

  it('names nothing when there is no catalog', async () => {
    const app = express();
    app.use('/api/v1', createConnectPageRouter(null));
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/connect-page`);
      expect(await res.json()).toBeNull();
      expect(res.headers.get('x-config-version')).toBeNull();
    } finally {
      await close();
    }
  });

  it('a Redis blip at a cold start: no catalog for the store’s pause only — then the saved one (review R2a-01)', async () => {
    const { redis, open } = closedRedis(await recordFor(CONNECT_PAGE_LKG, CATALOG));
    const tracker = new ConnectPageVersionTracker(
      new RedisConnectPageSnapshot({ redis: redis as never, store: new RedisLastKnownGoodStore({ redis: redis as never }) }),
    );
    const app = express();
    app.use(
      '/api/v1',
      createConnectPageRouter(
        {
          connectPage: {
            getEffective: async () => {
              throw new Error('connect ECONNREFUSED');
            },
          },
        } as never,
        tracker,
      ),
    );
    const { base, close } = await listen(app);
    try {
      expect(await (await fetch(`${base}/connect-page`)).json()).toBeNull();
      expect(tracker.heldVersion()).toBeNull();
      open();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + LAST_KNOWN_GOOD_RETRY_MS + 1);
      expect(await (await fetch(`${base}/connect-page`)).json()).toEqual(CATALOG);
      expect(tracker.heldVersion()).toBe(configVersionOf(CATALOG));
    } finally {
      await close();
    }
  });
});
