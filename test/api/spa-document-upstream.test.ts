import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import { resetLandingCache } from '../../src/api/routes/landing.js';
import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';

/**
 * SPA document upstream fan-out.
 *
 * `GET /` needs two independent answers from rezeis-admin: the effective
 * landing (SEO head) and the public config (branding head). They used to be
 * awaited one after the other, which on a separate-VPS deployment meant the
 * document was held for TWO headers timeouts (~10s each) whenever the panel
 * was down. Starting both before awaiting either halves that worst case, and
 * a serialised regression is invisible to every other assertion in the suite —
 * the response looks identical, it just takes twice as long.
 */

const OPERATOR_PUBLIC_CONFIG: PublicConfigSnapshot = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: '/uploads/branding/northern-lights.svg',
    pwaIconUrl: '/uploads/branding/northern-lights.png',
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
};

const INDEX_HTML =
  '<!doctype html><html><head><title>Reiwa</title></head><body><div id="root"></div></body></html>';

async function get(
  app: ReturnType<typeof createApp>,
  requestPath: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  } finally {
    server.close();
  }
}

/** Resolves after `ms`, without holding the event loop open on its own. */
function deadline(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

describe('SPA document upstream fan-out', () => {
  let webDist: string | null = null;
  let previousWebDist: string | undefined;

  beforeEach(async () => {
    resetLandingCache();
    resetBrandingCache();
    previousWebDist = process.env['REIWA_WEB_DIST'];
    webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-spa-document-'));
    await writeFile(path.join(webDist, 'index.html'), INDEX_HTML);
    process.env['REIWA_WEB_DIST'] = webDist;
  });

  afterEach(async () => {
    if (previousWebDist === undefined) delete process.env['REIWA_WEB_DIST'];
    else process.env['REIWA_WEB_DIST'] = previousWebDist;
    if (webDist !== null) await rm(webDist, { recursive: true, force: true });
    webDist = null;
    resetLandingCache();
    resetBrandingCache();
    vi.restoreAllMocks();
  });

  it('starts the landing and public-config lookups concurrently, not one after the other', async () => {
    const events: string[] = [];
    let releaseLanding: () => void = () => {};
    let releaseBranding: () => void = () => {};
    const landingGate = new Promise<void>((resolve) => {
      releaseLanding = resolve;
    });
    const brandingGate = new Promise<void>((resolve) => {
      releaseBranding = resolve;
    });
    let started = 0;
    let markStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      markStarted = () => {
        started += 1;
        if (started >= 2) resolve();
      };
    });

    const getEffective = vi.fn(async () => {
      events.push('landing:start');
      markStarted();
      await landingGate;
      events.push('landing:end');
      return { enabled: false };
    });
    const getReiwaPublicConfig = vi.fn(async () => {
      events.push('public-config:start');
      markStarted();
      await brandingGate;
      events.push('public-config:end');
      return OPERATOR_PUBLIC_CONFIG;
    });

    const app = createApp({
      adminClient: {
        landing: { getEffective },
        branding: { getReiwaPublicConfig },
      } as never,
      sessionStore: null,
      webSessionStore: null,
      config: {
        NODE_ENV: 'test',
        REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
      } as never,
    });

    const pending = get(app, '/');
    // Both calls must be in flight before either is allowed to answer. The
    // deadline is only an escape hatch: a serialised handler never reaches two
    // in-flight calls, and would otherwise hang here instead of failing.
    await Promise.race([bothStarted, deadline(2_000)]);
    releaseLanding();
    releaseBranding();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(getEffective).toHaveBeenCalledTimes(1);
    expect(getReiwaPublicConfig).toHaveBeenCalledTimes(1);
    // The first two recorded events are the two starts: neither lookup waited
    // for the other to finish. Serialised, this reads
    // ['landing:start', 'landing:end'].
    expect([...events.slice(0, 2)].sort()).toEqual(['landing:start', 'public-config:start']);
  });

  it('still serves the document when the panel is unreachable for both lookups', async () => {
    const getEffective = vi.fn(async () => {
      throw new Error('admin down');
    });
    const getReiwaPublicConfig = vi.fn(async () => {
      throw new Error('admin down');
    });

    const app = createApp({
      adminClient: {
        landing: { getEffective },
        branding: { getReiwaPublicConfig },
      } as never,
      sessionStore: null,
      webSessionStore: null,
      config: {
        NODE_ENV: 'test',
        REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
      } as never,
    });

    const response = await get(app, '/');

    // Unbranded shell, served straight from disk — the documented fallback.
    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });
});
