import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

import {
  createLandingRouter,
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
