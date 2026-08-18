/**
 * Request-level guard for the white-label PWA install surface.
 *
 * Both halves of "the operator's icon is what gets installed" are decided by
 * things a unit test cannot see:
 *
 *  - the MANIFEST is built by `buildWebManifest`, which already has unit
 *    coverage — but `web/dist/manifest.webmanifest` is a real, stock-branded
 *    file sitting in the directory `express.static` serves, so whether the
 *    operator ever sees the branded one is decided by ROUTE ORDER. A unit test
 *    of the builder passes identically whether the dynamic route wins or is
 *    dead code;
 *  - the DOCUMENT HEAD is what iOS "Add to Home Screen" and every crawler read.
 *    `branding-provider.tsx` patches those tags from a React effect, which
 *    never runs here and does not run for a crawler at all — so the only
 *    meaningful assertion is on the bytes the server actually wrote.
 *
 * Every assertion below is therefore made against a response body that came
 * back from a real `GET` on a mounted app whose `REIWA_WEB_DIST` holds the
 * stock files.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';

const OPERATOR_ICON = '/uploads/branding/northern-lights.png';
const OPERATOR_LOGO = '/uploads/branding/northern-lights.svg';
const OPERATOR_NAME = 'Northern Lights VPN';
const STOCK_ICON = '/icons/icon-192x192.png';

function operatorConfig(overrides: Record<string, unknown> = {}): PublicConfigSnapshot {
  return {
    branding: {
      themePresetId: 'concept-cz',
      themePresetVersion: 1,
      brandName: OPERATOR_NAME,
      logoUrl: OPERATOR_LOGO,
      pwaIconUrl: OPERATOR_ICON,
      primary: '#6750a4',
      primaryFg: '#ffffff',
      bgPrimary: '#121212',
      bgSecondary: '#242424',
      cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
      cardPattern: null,
      cardLogo: 'CUSTOM',
      cardLogoUrl: '/uploads/branding/card-logo.svg',
      cardEffect: 'aurora',
      cardEffectProps: {},
      cardEffectOpacity: 0.7,
      cardEffectsByIndex: [],
      bgEffect: 'AURORA',
      iconColorMode: 'default',
      iconColors: {},
      borderRadius: 'rounded-xl',
      fontFamily: 'Manrope, sans-serif',
      ...overrides,
    },
    locales: ['en', 'ru'],
    defaultLocale: 'en',
    defaultCurrency: 'EUR',
    customIcons: [],
    emailEnabled: true,
  } as unknown as PublicConfigSnapshot;
}

/** The file that ships in `web/public/` and is copied into `web/dist/`. */
const STOCK_STATIC_MANIFEST = JSON.stringify({
  name: 'Reiwa',
  short_name: 'Reiwa',
  description: 'Reiwa VPN Service',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  theme_color: '#020202',
  background_color: '#020202',
  icons: [
    { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
  ],
});

/** The head `web/index.html` actually ships, tags in their real order. */
const STOCK_INDEX_HTML = [
  '<!doctype html>',
  '<html lang="ru" class="dark">',
  '    <head>',
  '        <meta name="theme-color" content="#0a0a0a" />',
  '        <meta name="apple-mobile-web-app-title" content="Reiwa" />',
  '        <link rel="manifest" href="/manifest.webmanifest" />',
  '        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />',
  '        <link rel="icon" type="image/svg+xml" href="/Reiwa-logo.svg" />',
  '        <title>Reiwa</title>',
  '    </head>',
  '    <body><div id="root"></div></body>',
  '</html>',
].join('\n');

interface Fetched {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

async function get(app: ReturnType<typeof createApp>, requestPath: string): Promise<Fetched> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<Fetched>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              contentType: String(response.headers['content-type'] ?? ''),
              body,
            }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    });
  } finally {
    server.close();
  }
}

let webDist: string;
let previousWebDist: string | undefined;

beforeEach(async () => {
  resetBrandingCache();
  webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-pwa-'));
  await writeFile(path.join(webDist, 'manifest.webmanifest'), STOCK_STATIC_MANIFEST);
  await writeFile(path.join(webDist, 'index.html'), STOCK_INDEX_HTML);
  previousWebDist = process.env.REIWA_WEB_DIST;
  process.env.REIWA_WEB_DIST = webDist;
});

afterEach(async () => {
  if (previousWebDist === undefined) delete process.env.REIWA_WEB_DIST;
  else process.env.REIWA_WEB_DIST = previousWebDist;
  await rm(webDist, { recursive: true, force: true });
  resetBrandingCache();
});

function makeApp(config: PublicConfigSnapshot | null): ReturnType<typeof createApp> {
  return createApp({
    adminClient:
      config === null
        ? null
        : ({ branding: { getReiwaPublicConfig: async () => config } } as never),
    sessionStore: null,
    webSessionStore: null,
    config: { NODE_ENV: 'test', REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1' } as never,
  });
}

describe('GET /manifest.webmanifest (served, not built)', () => {
  it('serves the operator icon even though a stock manifest sits in web/dist', async () => {
    const response = await get(makeApp(operatorConfig()), '/manifest.webmanifest');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/manifest+json');

    const manifest = JSON.parse(response.body) as {
      name: string;
      icons: ReadonlyArray<{ src: string }>;
    };
    expect(manifest.name).toBe(OPERATOR_NAME);
    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      OPERATOR_ICON,
      OPERATOR_ICON,
      OPERATOR_ICON,
    ]);
    // The stock icons must not appear at all — that is what the static handler
    // would have answered with had it won the route.
    expect(response.body).not.toContain(STOCK_ICON);
  });

  it('still answers an installable manifest when the operator config is unavailable', async () => {
    const response = await get(makeApp(null), '/manifest.webmanifest');

    expect(response.status).toBe(200);
    const manifest = JSON.parse(response.body) as {
      name: string;
      icons: ReadonlyArray<{ src: string }>;
    };
    expect(manifest.name).toBe('Reiwa');
    expect(manifest.icons.some((icon) => icon.src === '/icons/icon-512x512.png')).toBe(true);
  });
});

describe('SPA document head (served bytes, before any JavaScript runs)', () => {
  // Both the landing entry and a deep client route: "Add to Home Screen" can be
  // tapped from any page, so a branded head on `/` alone would not be enough.
  for (const route of ['/', '/dashboard']) {
    it(`carries the operator icon and app title on ${route}`, async () => {
      const response = await get(makeApp(operatorConfig()), route);

      expect(response.status).toBe(200);
      expect(response.contentType).toContain('text/html');
      expect(response.body).toContain(`<link rel="apple-touch-icon" href="${OPERATOR_ICON}" />`);
      expect(response.body).toContain(`<link rel="icon" href="${OPERATOR_ICON}" />`);
      expect(response.body).toContain(
        `<meta name="apple-mobile-web-app-title" content="${OPERATOR_NAME}" />`,
      );
      // The stock tags are REPLACED, not merely followed by a branded one: a
      // second `apple-touch-icon` leaves the choice to the platform.
      expect(response.body).not.toContain(STOCK_ICON);
      expect(response.body).not.toContain('/Reiwa-logo.svg');
      expect(response.body).not.toContain('content="Reiwa"');
      // Neighbouring head tags survive untouched.
      expect(response.body).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
      expect(response.body).toContain('<meta name="theme-color" content="#0a0a0a" />');
      expect(response.body).toContain('<div id="root"></div>');
    });
  }

  it('falls back to logoUrl when no dedicated PWA icon is configured', async () => {
    const response = await get(makeApp(operatorConfig({ pwaIconUrl: null })), '/dashboard');

    expect(response.body).toContain(`<link rel="apple-touch-icon" href="${OPERATOR_LOGO}" />`);
  });

  it('hands iOS an icon it can actually decode', async () => {
    // `apple-touch-icon` is the ONLY thing iOS "Add to Home Screen" reads for
    // the home-screen icon, and Apple's own configuration guide specifies PNG:
    // Safari does not decode an SVG there. It does not fall back to the
    // manifest either — it falls back to a screenshot of the page. So an
    // operator whose PWA icon is a vector (the panel's upload accepts
    // png/webp/svg alike) ships a branded manifest, a branded favicon, and an
    // iPhone home screen with no logo on it at all.
    //
    // The fallback chain this codebase already uses everywhere else —
    // `pwaIconUrl → logoUrl` — has the answer sitting right there; this slot
    // just has to skip the candidate iOS cannot use.
    const response = await get(
      makeApp(
        operatorConfig({
          pwaIconUrl: '/uploads/branding/mark.svg',
          logoUrl: '/uploads/branding/mark.png',
        }),
      ),
      '/dashboard',
    );

    expect(
      response.body,
      'the iPhone home screen gets a vector it cannot render, and the operator sees no icon at all',
    ).toContain('<link rel="apple-touch-icon" href="/uploads/branding/mark.png" />');
    // The browser tab keeps the vector: SVG favicons are supported everywhere a
    // tab exists and stay crisp at every size. The two slots are allowed to
    // differ precisely because their consumers differ.
    expect(response.body).toContain('<link rel="icon" href="/uploads/branding/mark.svg" />');

    // The other end of the same rule: when NOTHING in the chain is raster, the
    // operator's vector still wins. Falling back to `/icons/icon-192x192.png`
    // here would put Reiwa's own icon on a white-label operator's home screen —
    // the exact complaint this whole surface exists to answer.
    resetBrandingCache();
    const vectorOnly = await get(
      makeApp(
        operatorConfig({
          pwaIconUrl: '/uploads/branding/mark.svg',
          logoUrl: '/uploads/branding/header.svg',
        }),
      ),
      '/dashboard',
    );

    expect(
      vectorOnly.body,
      'a white-label operator with only vector art was handed the stock Reiwa icon',
    ).not.toContain(STOCK_ICON);
    expect(vectorOnly.body).toContain(
      '<link rel="apple-touch-icon" href="/uploads/branding/mark.svg" />',
    );
  });

  it('escapes the icon URL so it cannot break out of the href attribute', async () => {
    // The public-config guard accepts any https URL, and its host/path test
    // admits a double quote — so the escaping here is load-bearing.
    const hostile = 'https://evil.example/x.png"><script>alert(1)</script>';
    const response = await get(makeApp(operatorConfig({ pwaIconUrl: hostile })), '/dashboard');

    expect(response.body).not.toContain('<script>alert(1)</script>');
    expect(response.body).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('writes the operator value literally, without expanding $-patterns', async () => {
    // `String.prototype.replace` with a STRING replacement expands `$&`, "$`"
    // and `$'` inside that string. The replacement here is built from operator
    // branding, and `escapeHtmlAttribute` cannot neutralise those: escaping the
    // apostrophe in `Nord$'VPN` produces `Nord$&#39;VPN`, which now contains a
    // literal `$&` — so the whole matched tag is spliced back into its own
    // attribute value and the delivered head is malformed for every visitor
    // until the operator renames themselves. Same for a `$&` in an icon URL.
    const response = await get(
      makeApp(
        operatorConfig({
          brandName: "Nord$'VPN",
          pwaIconUrl: 'https://cdn.example/mark$&v2.png',
        }),
      ),
      '/dashboard',
    );

    expect(
      response.body,
      'the app title tag was spliced into its own content attribute',
    ).toContain('content="Nord$&#39;VPN"');
    expect(
      response.body,
      'the icon tag was spliced into its own href attribute',
    ).toContain('href="https://cdn.example/mark$&amp;v2.png"');
    // One tag per slot: an expansion leaves a second, stock-valued copy behind.
    expect(response.body.match(/apple-mobile-web-app-title/g)).toHaveLength(1);
    expect(response.body.match(/rel="apple-touch-icon"/g)).toHaveLength(1);
  });

  it('leaves the stock head in place when the operator config is unavailable', async () => {
    const response = await get(makeApp(null), '/dashboard');

    expect(response.status).toBe(200);
    expect(response.body).toContain(`<link rel="apple-touch-icon" href="${STOCK_ICON}" />`);
  });

  it('does not inline an oversized data: icon into every document', async () => {
    // A 512 KB data URI is legal per the public-config guard. Paying for it on
    // every page load to decorate a tab is not; the manifest still carries it.
    const huge = `data:image/png;base64,${'A'.repeat(4096)}`;

    const document = await get(makeApp(operatorConfig({ pwaIconUrl: huge })), '/dashboard');
    // Falls through to the operator's OWN logo, not to Reiwa's stock icon.
    //
    // This assertion used to read `STOCK_ICON`, and that pinned a real defect:
    // `icon` was derived from the RAW chain instead of the length-filtered
    // candidates, so one oversized entry made it null and skipped the whole
    // block — handing a white-label operator `/icons/icon-192x192.png` while a
    // perfectly usable `logoUrl` sat in the very array built to prevent that.
    // The comment above the filter promised this behaviour; the code did not.
    //
    // `OPERATOR_LOGO` is an SVG and `apple-touch-icon` prefers raster, but with
    // the oversized PNG gone there is no raster left in the chain — and the
    // documented rule is that a vector still beats the stock icon.
    expect(document.body).toContain(`<link rel="apple-touch-icon" href="${OPERATOR_LOGO}" />`);
    expect(document.body).not.toContain(STOCK_ICON);
    // Still not inlined: the fallback is a short path, so the document stays small.
    expect(document.body.length).toBeLessThan(2_000);

    resetBrandingCache();
    const manifest = await get(
      makeApp(operatorConfig({ pwaIconUrl: huge })),
      '/manifest.webmanifest',
    );
    expect(manifest.body).toContain(huge);
  });
});
