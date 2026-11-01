import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { embedPublicConfig, neutralizeStockHead, serializeForScript } from '../../src/api/document-public-config.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import {
  DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH,
  type PublicConfigSnapshot,
} from '../../src/application/ports/public-config-persistence.port.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { splitEmbeddedPublicConfig } from './embedded-public-config.js';
import { sendSocketless } from './socketless-request.js';

/**
 * The SPA document carries the public config it was rendered with, so a first
 * visit starts in the operator's identity instead of the built-in «Reiwa» (the
 * owner, 01.11.2026: a friend «увидел reiwa а не мое название»).
 */

const TEMPLATE = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const CONFIG: PublicConfigSnapshot = {
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
  defaultLocale: 'ru',
  defaultCurrency: 'RUB',
  customIcons: [],
  platformBranding: { projectName: null, webTitle: null },
};

describe('serializeForScript', () => {
  it('cannot end the data block early, and reads back to the same value', () => {
    const value = { name: `</script><script>alert(1)</script> & <b> ${LINE_SEPARATOR}` };
    const json = serializeForScript(value);

    expect(json).not.toBeNull();
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(json).not.toContain(LINE_SEPARATOR);
    expect(JSON.parse(json!)).toEqual(value);
  });

  it('is null for what JSON cannot write down', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(serializeForScript(cycle)).toBeNull();
    expect(serializeForScript(undefined)).toBeNull();
  });
});

describe('embedPublicConfig', () => {
  it('goes in right before theme-bootstrap.js, which runs as the parser reaches it', () => {
    const html = embedPublicConfig(TEMPLATE, CONFIG);
    const element = html.indexOf('<script id="reiwa-public-config" type="application/json">');

    expect(element).toBeGreaterThan(0);
    expect(element).toBeLessThan(html.indexOf('<script src="/theme-bootstrap.js"></script>'));
    expect(splitEmbeddedPublicConfig(html)).toEqual({ html: TEMPLATE, config: CONFIG });
  });

  it('keeps a `$` in a name a `$`', () => {
    const config = { ...CONFIG, branding: { ...CONFIG.branding, brandName: "VPN $& $' $1" } };
    expect(splitEmbeddedPublicConfig(embedPublicConfig(TEMPLATE, config)).config).toEqual(config);
  });

  it('falls back to before </head>, and leaves a document with neither alone', () => {
    const bare = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const withHead = embedPublicConfig(bare, CONFIG);
    expect(withHead.indexOf('reiwa-public-config')).toBeLessThan(withHead.indexOf('</head>'));

    const headless = '<p>no head here</p>';
    expect(embedPublicConfig(headless, CONFIG)).toBe(headless);
  });

  it('carries nothing over its cap — an inline data: logo is not paid on every page load', () => {
    const logo = `data:image/png;base64,${'A'.repeat(DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH)}`;
    const config = { ...CONFIG, branding: { ...CONFIG.branding, logoUrl: logo } };
    expect(embedPublicConfig(TEMPLATE, config)).toBe(TEMPLATE);
  });

  it('carries nothing that is not an object', () => {
    expect(embedPublicConfig(TEMPLATE, null)).toBe(TEMPLATE);
    expect(embedPublicConfig(TEMPLATE, 'branding')).toBe(TEMPLATE);
  });
});

describe('neutralizeStockHead', () => {
  it('takes the build’s «Reiwa» out of the title and the home-screen title, and nothing else', () => {
    const neutral = neutralizeStockHead(TEMPLATE);

    expect(TEMPLATE).toContain('<title>Reiwa</title>');
    expect(neutral).toContain('<title></title>');
    expect(neutral).not.toContain('apple-mobile-web-app-title');
    expect(neutral).toContain('<script src="/theme-bootstrap.js"></script>');
    expect(neutral.split('\n').length).toBe(TEMPLATE.split('\n').length - 1);
  });

  it('leaves an operator’s title alone', () => {
    const named = TEMPLATE.replace('<title>Reiwa</title>', '<title>Northern Lights VPN</title>');
    expect(neutralizeStockHead(named)).toContain('<title>Northern Lights VPN</title>');
  });
});

describe('the SPA document the API serves', () => {
  let webDist: string | null = null;
  let previousWebDist: string | undefined;

  beforeEach(async () => {
    resetBrandingCache();
    setPolicyCache(null);
    previousWebDist = process.env['REIWA_WEB_DIST'];
    webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-doc-config-'));
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

  function build(getReiwaPublicConfig: () => Promise<unknown>) {
    return createApp({
      adminClient: { branding: { getReiwaPublicConfig } } as never,
      sessionStore: null,
      webSessionStore: null,
      config: {
        NODE_ENV: 'test',
        REIWA_COOKIE_SECURE: false,
        REIWA_ALLOW_INSECURE_COOKIES: true,
        REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
        BOT_USERNAME: '@northern_bot',
        BOT_SUPPORT_USERNAME: 'northern_support',
      } as never,
    });
  }

  it('carries exactly what GET /api/v1/public-config answers — the first frame and the first fetch agree', async () => {
    const app = build(async () => CONFIG);

    const document = await sendSocketless(app, { method: 'GET', url: '/subscription' });
    const fetched = await sendSocketless(app, { method: 'GET', url: '/api/v1/public-config' });

    expect(document.status).toBe(200);
    expect(fetched.status).toBe(200);
    const carried = splitEmbeddedPublicConfig(String(document.body)).config;
    expect(carried).toEqual(typeof fetched.body === 'string' ? JSON.parse(fetched.body) : fetched.body);
    expect(carried).toMatchObject({
      branding: { brandName: 'Northern Lights VPN' },
      botUsername: 'northern_bot',
      supportUsername: 'northern_support',
    });
    expect(String(document.body)).toContain('<title>Northern Lights VPN</title>');
  });

  it('withholds the support handle in the copy exactly as the route does when the operator switched the button off', async () => {
    const app = build(async () => ({ ...CONFIG, telegramSupportButton: false }));

    const document = await sendSocketless(app, { method: 'GET', url: '/' });

    expect(splitEmbeddedPublicConfig(String(document.body)).config).toMatchObject({ supportUsername: null });
  });

  it('serves a document with no copy when the operator config cannot be read — and no «Reiwa» in its head', async () => {
    const app = build(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const document = await sendSocketless(app, { method: 'GET', url: '/' });

    expect(document.status).toBe(200);
    expect(splitEmbeddedPublicConfig(String(document.body)).config).toBeNull();
    expect(String(document.body)).toContain('<title></title>');
  });
});
