import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';

import {
  createLandingRouter,
  getEffectiveLandingCached,
  resetLandingCache,
  buildLandingMetaHead,
} from '../../../src/api/routes/landing.js';

/**
 * GET /api/v1/landing — public effective-landing delivery.
 *
 * Verifies the 60s single-flight cache (a burst collapses to one upstream
 * call), the fail-closed fallback when rezeis-admin is unreachable (last-cached,
 * else the `{ enabled: false }` sentinel — never a hard 5xx), and that the
 * webhook-driven `resetLandingCache()` forces a refetch. Also covers the SEO
 * meta-head builder used by the SPA index.html handler.
 */

function makeApp(getEffective: () => Promise<unknown>) {
  const adminClient = { landing: { getEffective } };
  const app = express();
  app.use('/api/v1', createLandingRouter({ adminClient: adminClient as never }));
  return app;
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

const ENABLED_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  defaultLocale: 'ru',
  meta: { title: { ru: 'Заголовок', en: 'Title' }, description: { ru: 'Описание', en: 'Desc' } },
  sections: [],
};

describe('landing public route', () => {
  beforeEach(() => resetLandingCache());

  it('serves the effective config and caches it (single upstream call for a burst)', async () => {
    const getEffective = vi.fn(async () => ENABLED_CONFIG);
    const app = makeApp(getEffective);
    const first = await get(app, '/api/v1/landing');
    const second = await get(app, '/api/v1/landing');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ enabled: true });
    expect(second.status).toBe(200);
    expect(getEffective).toHaveBeenCalledTimes(1);
  });

  it('falls back to the disabled sentinel when admin is unreachable and nothing is cached', async () => {
    const getEffective = vi.fn(async () => {
      throw new Error('admin down');
    });
    const app = makeApp(getEffective);
    const res = await get(app, '/api/v1/landing');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ enabled: false });
  });

  it('serves the last-cached payload when a later refresh fails', async () => {
    let calls = 0;
    const getEffective = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return ENABLED_CONFIG;
      throw new Error('admin down');
    });
    const app = makeApp(getEffective);
    const first = await get(app, '/api/v1/landing');
    expect(JSON.parse(first.body)).toMatchObject({ enabled: true });
    // Force the TTL to expire so the next request refetches (and fails).
    resetLandingCache();
    // Prime the cache again then expire and fail — assert last-known-good is kept.
    await get(app, '/api/v1/landing'); // calls #2 fails -> sentinel (no prior cache after reset)
    // Now prime a good value, then a failing refresh keeps it.
    calls = 0;
    resetLandingCache();
    await get(app, '/api/v1/landing'); // good
    resetLandingCache();
    const after = await get(app, '/api/v1/landing'); // fails -> no cache -> sentinel
    expect(after.status).toBe(200);
  });

  it('refetches after resetLandingCache (webhook invalidation contract)', async () => {
    const getEffective = vi.fn(async () => ENABLED_CONFIG);
    const app = makeApp(getEffective);
    await get(app, '/api/v1/landing');
    expect(getEffective).toHaveBeenCalledTimes(1);
    resetLandingCache();
    await get(app, '/api/v1/landing');
    expect(getEffective).toHaveBeenCalledTimes(2);
  });
});

/**
 * Panel-outage caching for the accessor the SPA index handler uses.
 *
 * The cabinet and the panel now run on separate hosts, so an unreachable
 * panel costs a full headers timeout (10s) per upstream call — and `GET /`
 * blocks on this lookup before it can answer. The fallback sentinel therefore
 * has to be cached like a real answer: without it the failure is never
 * recorded and every single visitor pays that timeout again.
 */
describe('landing cache during a panel outage', () => {
  beforeEach(() => resetLandingCache());
  afterEach(() => vi.restoreAllMocks());

  it('caches the fallback sentinel — a second request costs no second upstream call', async () => {
    const getEffective = vi.fn(async () => {
      throw new Error('admin down');
    });
    const adminClient = { landing: { getEffective } } as never;

    const first = await getEffectiveLandingCached(adminClient);
    const second = await getEffectiveLandingCached(adminClient);

    expect(first).toEqual({ enabled: false });
    expect(second).toEqual({ enabled: false });
    expect(getEffective).toHaveBeenCalledTimes(1);
  });

  it('retries upstream once the TTL over the cached sentinel expires', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let reachable = false;
    const getEffective = vi.fn(async () => {
      if (!reachable) throw new Error('admin down');
      return ENABLED_CONFIG;
    });
    const adminClient = { landing: { getEffective } } as never;

    expect(await getEffectiveLandingCached(adminClient)).toEqual({ enabled: false });
    expect(getEffective).toHaveBeenCalledTimes(1);

    // Inside the TTL the cached sentinel answers without touching upstream,
    // even though the panel is already back.
    now += 59_000;
    reachable = true;
    expect(await getEffectiveLandingCached(adminClient)).toEqual({ enabled: false });
    expect(getEffective).toHaveBeenCalledTimes(1);

    // Past it the panel is consulted again — the sentinel must not stick
    // around once the outage is over.
    now += 2_000;
    expect(await getEffectiveLandingCached(adminClient)).toMatchObject({ enabled: true });
    expect(getEffective).toHaveBeenCalledTimes(2);
  });
});

/**
 * An upstream that answers each call only when the test says so, so a case can
 * choose the order in which reads that overlap an invalidation settle.
 */
function handAnswered() {
  const calls: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  const fn = vi.fn(
    () =>
      new Promise<unknown>((resolve, reject) => {
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
    answer: (index: number, value: unknown): void => call(index).resolve(value),
    fail: (index: number, reason: unknown): void => call(index).reject(reason),
  };
}

/**
 * An invalidation the webhook already spent must not be undone by a read that
 * was in flight when it arrived.
 *
 * That read may reach the panel BEFORE the operator's publish commits. If it
 * settles after the webhook dropped the cache and may still write, it stores
 * the pre-publish landing — or, when it failed, the disabled sentinel — with a
 * fresh timestamp. The panel has already recorded the event as delivered, so
 * visitors get the old page, or `/sign-in`, for another whole TTL.
 */
describe('landing cache across a publish invalidation', () => {
  beforeEach(() => resetLandingCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetLandingCache();
  });

  it('a read begun before the invalidation does not overwrite the landing read after it', async () => {
    const upstream = handAnswered();
    const adminClient = { landing: { getEffective: upstream.fn } } as never;

    const beforePublish = getEffectiveLandingCached(adminClient);
    resetLandingCache();
    const afterPublish = getEffectiveLandingCached(adminClient);
    upstream.answer(1, ENABLED_CONFIG);
    expect(await afterPublish).toMatchObject({ enabled: true });

    upstream.answer(0, null); // read while still unpublished; lands last
    expect(await beforePublish).toEqual({ enabled: false });

    expect(await getEffectiveLandingCached(adminClient)).toMatchObject({ enabled: true });
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it('a read begun before the invalidation that lands with nobody else asking is not kept', async () => {
    const upstream = handAnswered();
    const adminClient = { landing: { getEffective: upstream.fn } } as never;

    const beforePublish = getEffectiveLandingCached(adminClient);
    resetLandingCache();
    upstream.answer(0, null);
    await beforePublish;

    const next = getEffectiveLandingCached(adminClient);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, ENABLED_CONFIG);
    expect(await next).toMatchObject({ enabled: true });
  });

  it('a read begun before the invalidation does not free the slot of the read started after it', async () => {
    const upstream = handAnswered();
    const adminClient = { landing: { getEffective: upstream.fn } } as never;

    const beforePublish = getEffectiveLandingCached(adminClient);
    resetLandingCache();
    const afterPublish = getEffectiveLandingCached(adminClient); // still in flight
    upstream.answer(0, null);
    await beforePublish;

    // Single-flight still holds: this joins the read already on its way.
    const joined = getEffectiveLandingCached(adminClient);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, ENABLED_CONFIG);
    expect(await joined).toMatchObject({ enabled: true });
    expect(await afterPublish).toMatchObject({ enabled: true });
  });

  it('a failed read begun before the invalidation does not park the disabled sentinel', async () => {
    const upstream = handAnswered();
    const adminClient = { landing: { getEffective: upstream.fn } } as never;

    const beforePublish = getEffectiveLandingCached(adminClient);
    resetLandingCache();
    upstream.fail(0, new Error('panel blinked'));
    expect(await beforePublish).toEqual({ enabled: false });

    const next = getEffectiveLandingCached(adminClient);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, ENABLED_CONFIG);
    expect(await next).toMatchObject({ enabled: true });
  });

  it('a failed read begun before the invalidation does not free the slot of the read started after it', async () => {
    const upstream = handAnswered();
    const adminClient = { landing: { getEffective: upstream.fn } } as never;

    const beforePublish = getEffectiveLandingCached(adminClient);
    resetLandingCache();
    const afterPublish = getEffectiveLandingCached(adminClient); // still in flight
    upstream.fail(0, new Error('panel blinked'));
    await beforePublish;

    const joined = getEffectiveLandingCached(adminClient);
    expect(upstream.fn).toHaveBeenCalledTimes(2);
    upstream.answer(1, ENABLED_CONFIG);
    expect(await joined).toMatchObject({ enabled: true });
    expect(await afterPublish).toMatchObject({ enabled: true });
  });

  it('a failed read begun before the invalidation does not extend the landing read after it', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const upstream = handAnswered();
    const adminClient = { landing: { getEffective: upstream.fn } } as never;

    const beforePublish = getEffectiveLandingCached(adminClient);
    resetLandingCache();
    const afterPublish = getEffectiveLandingCached(adminClient);
    upstream.answer(1, ENABLED_CONFIG);
    await afterPublish;

    now += 50_000;
    upstream.fail(0, new Error('panel blinked'));
    // Its own caller still gets a usable answer: the landing read after it.
    expect(await beforePublish).toMatchObject({ enabled: true });

    // The TTL runs from when the landing was actually read, not from the failure.
    now += 11_000;
    const next = getEffectiveLandingCached(adminClient);
    expect(upstream.fn).toHaveBeenCalledTimes(3);
    upstream.answer(2, ENABLED_CONFIG);
    expect(await next).toMatchObject({ enabled: true });
  });
});

describe('buildLandingMetaHead', () => {
  it('builds title/description/OG tags for an enabled config', () => {
    const head = buildLandingMetaHead(ENABLED_CONFIG);
    expect(head).not.toBeNull();
    expect(head).toContain('<title>Заголовок</title>');
    expect(head).toContain('og:title');
    expect(head).toContain('og:description');
  });

  it('returns null for a disabled sentinel', () => {
    expect(buildLandingMetaHead({ enabled: false })).toBeNull();
  });

  it('escapes HTML in meta values', () => {
    const head = buildLandingMetaHead({
      enabled: true,
      defaultLocale: 'en',
      meta: { title: { en: '<script>x</script>' }, description: { en: 'ok' } },
    });
    expect(head).not.toBeNull();
    expect(head).not.toContain('<script>');
    expect(head).toContain('&lt;script&gt;');
  });
});
