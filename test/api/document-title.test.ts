import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { applyBrandingHead, applyDocumentTitle } from '../../src/api/branding-pwa.js';
import {
  MAX_DOCUMENT_NAME_LENGTH,
  STOCK_BRAND_NAME,
  cleanDocumentName,
  documentNamesOf,
} from '../../src/api/document-title.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { sendSocketless } from './socketless-request.js';

/**
 * The operator's name in the served document's `<title>` and link-preview tags
 * (the owner's decision of 26.09.2026: a shared cabinet link shows the
 * operator's name, never «Reiwa»; no description, no image).
 *
 * Pinned here: which name goes where (`document-title.ts`), that it is escaped
 * and bounded, that an operator with no name of their own gets exactly the
 * document the build ships, and that a save in the panel reaches the next
 * document with no restart. `test/web/document-title-parity.test.ts` holds the
 * SPA's tab title to the same rule.
 */

/** The template the image serves (`web/index.html`; the build keeps its head). */
const TEMPLATE = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

function config(
  brandName: unknown,
  platformBranding?: { webTitle?: unknown; projectName?: unknown },
): Record<string, unknown> {
  return {
    branding: { brandName },
    ...(platformBranding === undefined ? {} : { platformBranding }),
  };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('which name goes where', () => {
  it('the brand alone: the title and the site name are the brand («WEB Reiwa» → «Название бренда»)', () => {
    expect(documentNamesOf(config('Winger VPN'))).toEqual({ title: 'Winger VPN', siteName: 'Winger VPN' });
    expect(documentNamesOf(config('Winger VPN', { webTitle: null, projectName: null }))).toEqual({
      title: 'Winger VPN',
      siteName: 'Winger VPN',
    });
  });

  it('the title follows the tab: «Заголовок веб-страницы», then «Название проекта», then the brand', () => {
    expect(documentNamesOf(config('Winger VPN', { webTitle: 'Winger — быстрый VPN', projectName: 'Winger' }))).toEqual({
      title: 'Winger — быстрый VPN',
      siteName: 'Winger VPN',
    });
    expect(documentNamesOf(config('Winger VPN', { webTitle: '  ', projectName: 'Winger' }))).toEqual({
      title: 'Winger',
      siteName: 'Winger VPN',
    });
  });

  it('the stock brand is no brand: the site name falls back to the title, and with no title there is nothing', () => {
    expect(documentNamesOf(config(STOCK_BRAND_NAME, { webTitle: 'Winger — быстрый VPN' }))).toEqual({
      title: 'Winger — быстрый VPN',
      siteName: 'Winger — быстрый VPN',
    });
    expect(documentNamesOf(config(STOCK_BRAND_NAME))).toBeNull();
    expect(documentNamesOf(config(STOCK_BRAND_NAME, { webTitle: null, projectName: '' }))).toBeNull();
  });

  it('nothing usable is nothing — never a throw', () => {
    for (const body of [undefined, null, 42, 'Winger', [], {}, { branding: null }, config(''), config(7), config({})]) {
      expect(documentNamesOf(body)).toBeNull();
    }
  });

  it('folds whitespace and control characters, trims, and cuts at the panel’s longest name without splitting a character', () => {
    expect(cleanDocumentName(`  Winger\n\t VPN${BEL}${NUL}  `)).toBe('Winger VPN');
    const long = 'é'.repeat(MAX_DOCUMENT_NAME_LENGTH + 30);
    expect(Array.from(cleanDocumentName(long))).toHaveLength(MAX_DOCUMENT_NAME_LENGTH);
    // An astral character is two UTF-16 units; the cut counts characters.
    const shields = '🛡'.repeat(MAX_DOCUMENT_NAME_LENGTH + 5);
    const cut = cleanDocumentName(shields);
    expect(Array.from(cut)).toHaveLength(MAX_DOCUMENT_NAME_LENGTH);
    expect(cut).toBe('🛡'.repeat(MAX_DOCUMENT_NAME_LENGTH));
    const lastUnit = cut.charCodeAt(cut.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff, 'the cut left half a character').toBe(false);
    expect(MAX_DOCUMENT_NAME_LENGTH).toBe(128);
  });
});

describe('the head the document is served with', () => {
  it('names the page and its preview after the operator, once each, and touches nothing else', () => {
    const html = applyDocumentTitle(TEMPLATE, config('Winger VPN'));

    expect(html).toContain('<title>Winger VPN</title>');
    expect(count(html, '<title>')).toBe(1);
    expect(html).not.toContain('<title>Reiwa</title>');
    expect(count(html, '<meta property="og:title" content="Winger VPN" />')).toBe(1);
    expect(count(html, '<meta property="og:site_name" content="Winger VPN" />')).toBe(1);
    expect(count(html, '<meta name="twitter:card" content="summary" />')).toBe(1);
    expect(count(html, '<meta name="twitter:title" content="Winger VPN" />')).toBe(1);
    // No description and no image — the owner's decision.
    expect(html).not.toMatch(/og:description|og:image|twitter:description|twitter:image|name="description"/);
    // Everything else is the template, byte for byte.
    const restored = html
      .replace('<title>Winger VPN</title>', '<title>Reiwa</title>')
      .replace(
        '<meta property="og:title" content="Winger VPN" /><meta property="og:site_name" content="Winger VPN" /><meta name="twitter:card" content="summary" /><meta name="twitter:title" content="Winger VPN" />',
        '',
      );
    expect(restored).toBe(TEMPLATE);
  });

  it('an operator with no name of their own gets the template back untouched — exactly what the build ships', () => {
    expect(applyDocumentTitle(TEMPLATE, config(STOCK_BRAND_NAME))).toBe(TEMPLATE);
    expect(applyDocumentTitle(TEMPLATE, undefined)).toBe(TEMPLATE);
    expect(TEMPLATE).toContain('<title>Reiwa</title>');
    expect(TEMPLATE).not.toContain('og:');
  });

  it('escapes the name: markup and quotes arrive as text, not as tags', () => {
    const hostile = '</title><script>alert("x")</script><meta name=\'a\' content="b">&co';
    const html = applyDocumentTitle(TEMPLATE, config(hostile));

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('</title><script>');
    expect(count(html, '</title>')).toBe(1);
    const escaped =
      '&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;meta name=&#39;a&#39; content=&quot;b&quot;&gt;&amp;co';
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${escaped}" />`);
    expect(html).toContain(`<meta property="og:site_name" content="${escaped}" />`);
  });

  it('writes a `$` in a name as a `$` — a replacement pattern would splice the matched tag in', () => {
    const html = applyDocumentTitle(TEMPLATE, config("Cash$&Go $' $`"));
    expect(html).toContain("<title>Cash$&amp;Go $&#39; $`</title>");
    expect(count(html, '<title>')).toBe(1);
  });

  it('keeps a twitter card the template already declares', () => {
    const template = TEMPLATE.replace('</head>', '<meta name="twitter:card" content="summary_large_image" /></head>');
    const html = applyDocumentTitle(template, config('Winger VPN'));
    expect(count(html, 'name="twitter:card"')).toBe(1);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });
});

describe('the document the API serves', () => {
  const WEBHOOK_SECRET = 'webhook-secret-for-document-title';
  let webDist: string | null = null;
  let previousWebDist: string | undefined;

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

  function withBrand(brandName: string, webTitle: string | null = null): PublicConfigSnapshot {
    return {
      ...APPEARANCE,
      branding: { ...APPEARANCE.branding, brandName },
      platformBranding: { projectName: null, webTitle },
    };
  }

  /** A panel whose answer the case changes, as an operator's save would. */
  function panel(initial: PublicConfigSnapshot) {
    let current = initial;
    const getReiwaPublicConfig = vi.fn(async () => current);
    return {
      client: { branding: { getReiwaPublicConfig } },
      getReiwaPublicConfig,
      save: (next: PublicConfigSnapshot) => {
        current = next;
      },
    };
  }

  function build(client: unknown) {
    return createApp({
      adminClient: client as never,
      sessionStore: null,
      webSessionStore: null,
      config: {
        NODE_ENV: 'test',
        REIWA_COOKIE_SECURE: false,
        REIWA_ALLOW_INSECURE_COOKIES: true,
        REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
        REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      } as never,
    });
  }

  function sign(body: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  async function hint(app: unknown, event: string) {
    const body = { event, metadata: { reason: 'operator-save' } };
    return sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/webhooks/rezeis',
      headers: { 'x-rezeis-signature': sign(JSON.stringify(body)) },
      body,
    });
  }

  async function documentAt(app: unknown, url: string, headers?: Record<string, string>) {
    return sendSocketless(app, { method: 'GET', url, ...(headers ? { headers } : {}) });
  }

  function text(body: unknown): string {
    return typeof body === 'string' ? body : String(body ?? '');
  }

  beforeEach(async () => {
    resetBrandingCache();
    setPolicyCache(null);
    previousWebDist = process.env['REIWA_WEB_DIST'];
    webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-document-title-'));
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

  it('carries the operator’s name on every path — the root, /welcome, a deep link', async () => {
    const app = build(panel(APPEARANCE).client);
    for (const url of ['/', '/welcome?utm_source=vk', '/dashboard']) {
      const res = await documentAt(app, url);
      expect(res.status, url).toBe(200);
      expect(text(res.body), url).toContain('<title>Northern Lights VPN</title>');
      expect(text(res.body), url).toContain('<meta property="og:site_name" content="Northern Lights VPN" />');
      expect(text(res.body), url).toContain('<meta name="twitter:title" content="Northern Lights VPN" />');
    }
  });

  it('a save in «WEB Reiwa» reaches the next document with the copy — no restart', async () => {
    const upstream = panel(APPEARANCE);
    const app = build(upstream.client);
    expect(text((await documentAt(app, '/')).body)).toContain('<title>Northern Lights VPN</title>');

    upstream.save(withBrand('Aurora Tunnel'));
    expect((await hint(app, 'reiwa.branding.invalidate')).status).toBe(204);

    await vi.waitFor(async () => {
      expect(text((await documentAt(app, '/')).body)).toContain('<title>Aurora Tunnel</title>');
    });
    expect(text((await documentAt(app, '/')).body)).toContain('<meta property="og:title" content="Aurora Tunnel" />');
  });

  it('a save of «Заголовок веб-страницы» on «Платформа» reaches it the same way, and the brand stays the site name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const upstream = panel(APPEARANCE);
    const app = build(upstream.client);
    await documentAt(app, '/');

    upstream.save(withBrand('Northern Lights VPN', 'Northern Lights — быстрый VPN'));
    expect((await hint(app, 'reiwa.platform.policy_invalidated')).status).toBe(204);

    await vi.waitFor(async () => {
      expect(text((await documentAt(app, '/')).body)).toContain('<title>Northern Lights — быстрый VPN</title>');
    });
    expect(text((await documentAt(app, '/')).body)).toContain(
      '<meta property="og:site_name" content="Northern Lights VPN" />',
    );
  });

  it('with no name of the operator’s own, the document is exactly today’s: the build’s «Reiwa», no preview tags', async () => {
    const branding = withBrand(STOCK_BRAND_NAME).branding;
    const app = build(panel(withBrand(STOCK_BRAND_NAME)).client);

    const res = await documentAt(app, '/');

    expect(res.status).toBe(200);
    expect(text(res.body)).toBe(applyBrandingHead(TEMPLATE, branding as Parameters<typeof applyBrandingHead>[1]));
    expect(text(res.body)).toContain('<title>Reiwa</title>');
    expect(text(res.body)).not.toMatch(/og:|twitter:/);
  });

  it('with the branding unreadable, the document is the build’s file, byte for byte', async () => {
    const app = build({
      branding: {
        getReiwaPublicConfig: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
    });

    const res = await documentAt(app, '/');

    expect(res.status).toBe(200);
    expect(text(res.body)).toBe(TEMPLATE);
  });

  it('is revalidated on every load, and a renamed operator is never answered 304 with the old name', async () => {
    const upstream = panel(APPEARANCE);
    const app = build(upstream.client);
    const first = await documentAt(app, '/');
    const etag = String(first.headers['etag'] ?? '');
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(etag).not.toBe('');

    // Unchanged: the browser keeps what it has.
    expect((await documentAt(app, '/', { 'if-none-match': etag })).status).toBe(304);

    upstream.save(withBrand('Aurora Tunnel'));
    await hint(app, 'reiwa.branding.invalidate');
    await vi.waitFor(async () => {
      const again = await documentAt(app, '/', { 'if-none-match': etag });
      expect(again.status).toBe(200);
      expect(text(again.body)).toContain('<title>Aurora Tunnel</title>');
    });
  });
});
