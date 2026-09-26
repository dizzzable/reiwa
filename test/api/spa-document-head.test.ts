import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { sendSocketless, type SocketlessResponse } from './socketless-request.js';

/**
 * A HEAD of a cabinet page is answered exactly as its GET: the same status and
 * the same headers — the operator's title included, so the same `ETag` — and
 * no body (review R1-24).
 *
 * Uptime monitors and `curl -I` check the cabinet's root with HEAD. From
 * 0.9.6.20 to 0.9.7.53 the dedicated `app.get(["/", "/welcome"])` route
 * answered it 200; 0.9.7.54 removed that route with the landing, and the
 * document fallback, which let only GET through, answered 404 — "down" on the
 * operator's monitor right after the update, while every browser got 200.
 *
 * `/welcome` has no redirect on the server for a plain link: GET answers the
 * document, and the SPA moves to `/sign-in` (`web/test/welcome-alias.test.tsx`).
 * The one server redirect there is the ad-code capture's 302, which stays
 * GET-only on purpose: a HEAD is no visitor arriving from an ad, and must not
 * count an open or park a cookie (`ad-capture.test.ts`).
 */

const TEMPLATE = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

const APPEARANCE: PublicConfigSnapshot = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: null,
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
    cardLogo: 'DEFAULT',
    cardLogoUrl: null,
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 0.7,
    cardEffectsByIndex: [],
    bgEffect: 'AURORA',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
  platformBranding: { projectName: null, webTitle: null },
};

function build(getReiwaPublicConfig: () => Promise<unknown>, recordClick = vi.fn(async () => undefined)) {
  const app = createApp({
    adminClient: { branding: { getReiwaPublicConfig }, advertising: { recordClick } } as never,
    sessionStore: null,
    webSessionStore: null,
    config: {
      NODE_ENV: 'test',
      REIWA_COOKIE_SECURE: false,
      REIWA_ALLOW_INSECURE_COOKIES: true,
      REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
    } as never,
  });
  return { app, recordClick };
}

/** The headers a HEAD must repeat: all of them but the per-request id. */
function comparable(res: SocketlessResponse): Record<string, unknown> {
  const { 'x-request-id': _requestId, ...rest } = res.headers as Record<string, unknown>;
  return rest;
}

function text(body: unknown): string {
  return typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
}

describe('HEAD of a cabinet page (review R1-24)', () => {
  let webDist: string | null = null;
  let previousWebDist: string | undefined;

  beforeEach(async () => {
    resetBrandingCache();
    setPolicyCache(null);
    previousWebDist = process.env['REIWA_WEB_DIST'];
    webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-spa-head-'));
    await writeFile(path.join(webDist, 'index.html'), TEMPLATE);
    process.env['REIWA_WEB_DIST'] = webDist;
  });

  afterEach(async () => {
    if (previousWebDist === undefined) delete process.env['REIWA_WEB_DIST'];
    else process.env['REIWA_WEB_DIST'] = previousWebDist;
    if (webDist !== null) await rm(webDist, { recursive: true, force: true });
    webDist = null;
    resetBrandingCache();
    setPolicyCache(null);
    vi.restoreAllMocks();
  });

  it('HEAD / is 200 text/html with no body — the headers of GET /, the operator’s title and all', async () => {
    const { app } = build(async () => APPEARANCE);

    const get = await sendSocketless(app, { method: 'GET', url: '/' });
    const head = await sendSocketless(app, { method: 'HEAD', url: '/' });

    expect(get.status).toBe(200);
    expect(text(get.body)).toContain('<title>Northern Lights VPN</title>');
    expect(head.status).toBe(200);
    expect(String(head.headers['content-type'])).toContain('text/html');
    expect(text(head.body)).toBe('');
    // Same document, same bytes: the same length and the same ETag.
    expect(comparable(head)).toEqual(comparable(get));
    expect(head.headers['etag']).toBeDefined();
  });

  it('HEAD /welcome?utm_source=x is answered as its GET — the document; the move to /sign-in is the SPA’s', async () => {
    const { app } = build(async () => APPEARANCE);

    const get = await sendSocketless(app, { method: 'GET', url: '/welcome?utm_source=x' });
    const head = await sendSocketless(app, { method: 'HEAD', url: '/welcome?utm_source=x' });

    expect(get.status).toBe(200);
    expect(get.headers['location']).toBeUndefined();
    expect(head.status).toBe(get.status);
    expect(comparable(head)).toEqual(comparable(get));
    expect(text(head.body)).toBe('');
  });

  it('a HEAD with an ad code is not a visitor: no 302, no open counted, no cookie — the page’s headers', async () => {
    const { app, recordClick } = build(async () => APPEARANCE);

    const head = await sendSocketless(app, { method: 'HEAD', url: '/welcome?campaign=ad_abc123&utm_source=x' });

    expect(head.status).toBe(200);
    expect(head.headers['location']).toBeUndefined();
    expect(head.headers['set-cookie']).toBeUndefined();
    expect(recordClick).not.toHaveBeenCalled();
    // Anchor: the same link as a GET is the capture's redirect.
    const get = await sendSocketless(app, { method: 'GET', url: '/welcome?campaign=ad_abc123&utm_source=x' });
    expect(get.status).toBe(302);
    expect(get.headers['location']).toBe('/welcome?utm_source=x');
  });

  it('HEAD / with the branding unreadable is 200 too — the build’s file, headers only', async () => {
    const { app } = build(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const get = await sendSocketless(app, { method: 'GET', url: '/' });
    const head = await sendSocketless(app, { method: 'HEAD', url: '/' });

    expect(get.status).toBe(200);
    expect(text(get.body)).toBe(TEMPLATE);
    expect(head.status).toBe(200);
    expect(String(head.headers['content-type'])).toContain('text/html');
    expect(text(head.body)).toBe('');
  });

  it('a HEAD to an API path nothing serves stays 404 — the document fallback never answers under /api/', async () => {
    const { app } = build(async () => APPEARANCE);

    for (const url of ['/api/v1/no-such-route', '/api/v1/landing']) {
      const head = await sendSocketless(app, { method: 'HEAD', url });
      expect(head.status, url).toBe(404);
      expect(head.headers['etag'], url).toBeUndefined();
      const get = await sendSocketless(app, { method: 'GET', url });
      expect(get.status, url).toBe(404);
      expect(text(get.body), url).not.toContain('<div id="root">');
    }
  });

  it('other methods are still not the document’s business', async () => {
    const { app } = build(async () => APPEARANCE);
    const post = await sendSocketless(app, { method: 'POST', url: '/', body: {} });
    expect(post.status).toBe(404);
    expect(text(post.body)).not.toContain('<div id="root">');
  });
});
