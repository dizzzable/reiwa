import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';

/**
 * What the SPA document asks the panel for.
 *
 * `GET /` and `GET /welcome` used to need two answers from rezeis-admin: the
 * effective web landing (its `<title>` and preview tags) and the public config
 * (the branding head). The cabinet shows no landing since 0.9.7.54, so a
 * document asks for ONE thing, the public config, whatever its path — and a
 * panel that still serves a landing is never asked for it.
 */

/** A snapshot the public-config guard accepts whole, so the head is branded. */
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

/**
 * A panel client that answers the public config and records every namespace
 * the app reaches for. The landing namespace is there — a panel 0.9.7.70 still
 * serves a published landing — so a lookup that came back would find it, and
 * the record would show it.
 */
function recordingPanel(getReiwaPublicConfig: () => Promise<unknown>) {
  const reached: string[] = [];
  const getEffective = vi.fn(async () => ({
    enabled: true,
    schemaVersion: 1,
    defaultLocale: 'ru',
    sections: [{ type: 'hero' }],
    meta: { title: { ru: 'Лендинг из панели' } },
  }));
  const client = new Proxy(
    { branding: { getReiwaPublicConfig }, landing: { getEffective } } as Record<string, unknown>,
    {
      get(target, property, receiver) {
        if (typeof property === 'string') reached.push(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );
  return { client, reached, getEffective };
}

describe('SPA document upstream lookups', () => {
  let webDist: string | null = null;
  let previousWebDist: string | undefined;

  beforeEach(async () => {
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
    resetBrandingCache();
    vi.restoreAllMocks();
  });

  for (const route of ['/', '/welcome', '/welcome?utm_source=vk&ref=friend']) {
    it(`${route}: one lookup, the public config, and never the landing`, async () => {
      const getReiwaPublicConfig = vi.fn(async () => OPERATOR_PUBLIC_CONFIG);
      const panel = recordingPanel(getReiwaPublicConfig);
      const app = createApp({
        adminClient: panel.client as never,
        sessionStore: null,
        webSessionStore: null,
        config: {
          NODE_ENV: 'test',
          REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
        } as never,
      });

      const response = await get(app, route);

      expect(response.status).toBe(200);
      // The branded shell, named after the operator (`document-title.ts`), and
      // nothing of the landing's — neither its title nor a description or image.
      expect(response.body).toContain('<meta name="apple-mobile-web-app-title" content="Northern Lights VPN" />');
      expect(response.body).toContain('<title>Northern Lights VPN</title>');
      expect(response.body).toContain('<meta property="og:title" content="Northern Lights VPN" />');
      expect(response.body).not.toContain('Лендинг из панели');
      expect(response.body).not.toMatch(/og:description|og:image|name="description"/);
      expect(getReiwaPublicConfig).toHaveBeenCalledTimes(1);
      expect(panel.getEffective).not.toHaveBeenCalled();
      expect(panel.reached, 'the document reached for the panel landing').not.toContain('landing');
    });
  }

  it('still serves the document when the panel is unreachable', async () => {
    const getReiwaPublicConfig = vi.fn(async () => {
      throw new Error('admin down');
    });
    const panel = recordingPanel(getReiwaPublicConfig);

    const app = createApp({
      adminClient: panel.client as never,
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
    expect(panel.getEffective).not.toHaveBeenCalled();
  });
});
