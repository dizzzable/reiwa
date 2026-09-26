import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import { resetConnectPageCache } from '../../src/api/routes/connect-page.js';
import type { PublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { configVersionOf } from '../../src/infrastructure/config-versions/config-version.js';
import {
  CONFIG_VERSION_POLL_INTERVAL_MS,
  ConfigVersionPoller,
  type ConfigVersionsReport,
  type VersionedGroup,
} from '../../src/infrastructure/config-versions/poller.js';
import { PUBLIC_CONFIG_LKG } from '../../src/infrastructure/public-config/redis-public-config-persistence.js';
import { lastKnownGoodKey } from '../../src/infrastructure/redis/keys.js';
import { sourceFiles } from '../support/source-scan.js';
import { sendSocketless } from './socketless-request.js';

/**
 * The cabinet shows no web landing since 0.9.7.54 — the owner removed it with
 * no replacement — and it has to live beside every panel it meets:
 *
 *   - 0.9.7.70 still has «Веб-лендинг»: it serves a published landing on
 *     `GET /api/internal/landing-config/effective`, versions it as `landing` in
 *     the poll's answer, and sends `reiwa.landing.invalidate` on every publish;
 *   - 0.9.7.71 keeps that route as a shim answering `{"enabled":false}`, and
 *     the `landing` version, for the cabinets before this one.
 *
 * This cabinet asks for neither, acks the hint with 204 so the older panel
 * counts it delivered, and never reads or serves the copy of a landing that a
 * 0.9.7.53 cabinet kept in Redis. The document side — `/` and `/welcome` ask
 * the panel for the public config and nothing else — is
 * `spa-document-upstream.test.ts`; the browser side is
 * `web/test/welcome-alias.test.tsx`.
 */

const WEBHOOK_SECRET = 'webhook-secret-for-landing-retired';

const INDEX_HTML =
  '<!doctype html><html><head><title>Reiwa</title></head><body><div id="root"></div></body></html>';

/** What a panel 0.9.7.70 serves for a published landing. */
const PUBLISHED_LANDING = {
  schemaVersion: 1,
  enabled: true,
  defaultLocale: 'ru',
  sections: [{ type: 'hero', visible: true }],
  meta: { title: { ru: 'E2E landing' }, description: { ru: 'Лендинг из панели' } },
};

/** A snapshot the public-config guard accepts whole. */
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
};

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/**
 * A panel 0.9.7.70 as the cabinet's client sees it: the appearance, the ad
 * opens — and the landing namespace, ready to answer a published landing. Every
 * namespace the app reaches for is written down, so a read of the landing that
 * came back would show here even where nothing else could tell.
 */
function panel070() {
  const reached: string[] = [];
  const getEffective = vi.fn(async () => PUBLISHED_LANDING);
  const getReiwaPublicConfig = vi.fn(async () => APPEARANCE);
  const recordClick = vi.fn(async () => undefined);
  const client = new Proxy(
    {
      branding: { getReiwaPublicConfig },
      advertising: { recordClick },
      landing: { getEffective },
    } as Record<string, unknown>,
    {
      get(target, property, receiver) {
        if (typeof property === 'string') reached.push(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );
  return { client, reached, getEffective, getReiwaPublicConfig, recordClick };
}

/** reiwa's Redis, in memory, with every key a GET asked for written down. */
function redisDouble(initial: Record<string, string> = {}) {
  const strings = new Map<string, string>(Object.entries(initial));
  const hashes = new Map<string, Map<string, string>>();
  const asked: string[] = [];
  const deleted: string[] = [];
  return {
    strings,
    asked,
    deleted,
    redis: {
      get: vi.fn(async (key: string) => {
        asked.push(key);
        return strings.get(key) ?? null;
      }),
      set: vi.fn(async (key: string, value: string) => {
        strings.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        deleted.push(key);
        return strings.delete(key) ? 1 : 0;
      }),
      hset: vi.fn(async (key: string, fields: Record<string, string>) => {
        const hash = hashes.get(key) ?? new Map<string, string>();
        for (const [field, value] of Object.entries(fields)) hash.set(field, value);
        hashes.set(key, hash);
        return 1;
      }),
      hgetall: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map<string, string>())),
    },
  };
}

function build(client: unknown, redis: unknown = null) {
  return createApp({
    adminClient: client as never,
    sessionStore: null,
    webSessionStore: redis === null ? null : ({ getRedis: () => redis } as never),
    config: {
      NODE_ENV: 'test',
      REIWA_COOKIE_SECURE: false,
      REIWA_ALLOW_INSECURE_COOKIES: true,
      REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
      REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as never,
  });
}

async function landingHint(app: unknown) {
  const body = { event: 'reiwa.landing.invalidate', metadata: { reason: 'publish' } };
  return sendSocketless(app, {
    method: 'POST',
    url: '/api/v1/webhooks/rezeis',
    headers: { 'x-rezeis-signature': sign(JSON.stringify(body)) },
    body,
  });
}

function text(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body ?? null);
}

function resetAll(): void {
  resetBrandingCache();
  resetConnectPageCache();
  setPolicyCache(null);
}

describe('a cabinet without the web landing, beside any panel', () => {
  let webDist: string | null = null;
  let previousWebDist: string | undefined;

  beforeEach(async () => {
    resetAll();
    previousWebDist = process.env['REIWA_WEB_DIST'];
    webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-landing-retired-'));
    await writeFile(path.join(webDist, 'index.html'), INDEX_HTML);
    process.env['REIWA_WEB_DIST'] = webDist;
  });

  afterEach(async () => {
    if (previousWebDist === undefined) delete process.env['REIWA_WEB_DIST'];
    else process.env['REIWA_WEB_DIST'] = previousWebDist;
    if (webDist !== null) await rm(webDist, { recursive: true, force: true });
    webDist = null;
    resetAll();
    vi.restoreAllMocks();
  });

  it('GET /api/v1/landing is a 404 — not the SPA document, and no panel read', async () => {
    // A page of 0.9.7.53 left open still asks; a 404 is what it reads as "no
    // landing". The SPA document here would be HTML under a JSON route.
    const panel = panel070();
    const app = build(panel.client);

    const res = await sendSocketless(app, { method: 'GET', url: '/api/v1/landing' });

    expect(res.status).toBe(404);
    expect(text(res.body)).not.toContain('<div id="root">');
    expect(text(res.body)).not.toContain('E2E landing');
    expect(panel.getEffective).not.toHaveBeenCalled();
    expect(panel.reached).not.toContain('landing');
  });

  it('acks a signed reiwa.landing.invalidate from a panel up to 0.9.7.70 with 204, and drops nothing', async () => {
    // A 2xx is what makes the older panel count the hint delivered; anything
    // else is retried and then reported to its operator as undelivered.
    const panel = panel070();
    const app = build(panel.client);
    await sendSocketless(app, { method: 'GET', url: '/api/v1/public-config' });
    const held = (await sendSocketless(app, { method: 'GET', url: '/api/v1/config-versions' })).body;

    const hint = await landingHint(app);

    expect(hint.status).toBe(204);
    // Nothing was reset and nothing re-read: the appearance is held as it was,
    // and the panel was asked for it once, before the hint.
    expect((await sendSocketless(app, { method: 'GET', url: '/api/v1/config-versions' })).body).toEqual(held);
    expect((held as { versions: Record<string, unknown> }).versions['publicConfig']).toBe(configVersionOf(APPEARANCE));
    expect(panel.getReiwaPublicConfig).toHaveBeenCalledTimes(1);
    expect(panel.getEffective).not.toHaveBeenCalled();
    expect(panel.reached).not.toContain('landing');
  });

  it('an unsigned landing hint is still refused, as every hint is', async () => {
    const app = build(panel070().client);
    const res = await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/webhooks/rezeis',
      body: { event: 'reiwa.landing.invalidate', metadata: {} },
    });
    expect(res.status).toBe(401);
  });

  it('has no landing group: /config-versions does not name it, and the poll neither reports it nor re-reads it', async () => {
    const panel = panel070();
    const app = build(panel.client);
    await sendSocketless(app, { method: 'GET', url: '/api/v1/public-config' });

    const versions = (await sendSocketless(app, { method: 'GET', url: '/api/v1/config-versions' })).body as {
      versions: Record<string, unknown>;
    };
    expect(Object.keys(versions.versions)).not.toContain('landing');

    // The poll as `api/main.ts` wires it, answered the way a panel 0.9.7.70
    // answers: its own `landing` among the groups, at a version of its own.
    const reports: ConfigVersionsReport[] = [];
    const heard: Array<Readonly<Record<string, string>>> = [];
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: app.locals['configVersionGroups'] as readonly VersionedGroup[],
      poll: async (report) => {
        reports.push(report);
        return {
          versions: {
            publicConfig: configVersionOf(APPEARANCE),
            landing: configVersionOf(PUBLISHED_LANDING),
            connectPage: 'c'.repeat(32),
          },
        };
      },
      onVersions: (answered) => heard.push(answered),
    });

    // Nothing to re-read: the next poll waits its interval, not a follow-up.
    expect(await poller.tick()).toBe(CONFIG_VERSION_POLL_INTERVAL_MS);
    expect(Object.keys(reports[0]?.held ?? {}).sort()).toEqual([
      'connectPage',
      'customEmojiPacks',
      'guestSupport',
      'platformPolicy',
      'publicConfig',
    ]);
    // The whole answer is heard — the extra key is recorded like any other.
    expect(heard[0]?.['landing']).toBe(configVersionOf(PUBLISHED_LANDING));
    expect(panel.getEffective).not.toHaveBeenCalled();
    expect(panel.reached).not.toContain('landing');
  });

  it('never reads — so never serves — the landing a 0.9.7.53 cabinet kept in Redis, and leaves it there', async () => {
    // The key and record exactly as 0.9.7.53 saved them (`LANDING_LKG`, shape 1).
    const key = lastKnownGoodKey('landing', 1);
    expect(key).toBe('reiwa:lkg:landing:v1');
    const record = {
      shape: 1,
      savedAt: 1_790_000_000_000,
      hash: configVersionOf(PUBLISHED_LANDING),
      payload: PUBLISHED_LANDING,
    };
    const store = redisDouble({ [key]: JSON.stringify(record) });
    // The panel is down: nothing it could say stands between a visitor and
    // whatever the cabinet finds in Redis.
    const down = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const app = build({ branding: { getReiwaPublicConfig: down } }, store.redis);

    const answers = [
      await sendSocketless(app, { method: 'GET', url: '/' }),
      await sendSocketless(app, { method: 'GET', url: '/welcome' }),
      await sendSocketless(app, { method: 'GET', url: '/api/v1/landing' }),
      await sendSocketless(app, { method: 'GET', url: '/api/v1/config-versions' }),
      await landingHint(app),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 404, 200, 204]);
    for (const answer of answers) expect(text(answer.body)).not.toContain('E2E landing');
    // Non-vacuity: with the panel down the documents DID go to Redis — for the
    // appearance's copy, which is still kept.
    expect(store.asked).toContain(lastKnownGoodKey(PUBLIC_CONFIG_LKG.name, PUBLIC_CONFIG_LKG.shape));
    expect(store.asked.filter((asked) => asked.includes('landing')), store.asked.join(', ')).toEqual([]);
    // Left in place: nothing here reads it, and a rollback to 0.9.7.53 finds
    // its own copy again.
    expect(store.deleted).not.toContain(key);
    expect(store.strings.get(key)).toBe(JSON.stringify(record));
  });

  it('an ad link to /welcome: the placement is counted, and every other parameter reaches the page', async () => {
    const panel = panel070();
    const app = build(panel.client);

    const first = await sendSocketless(app, {
      method: 'GET',
      url: '/welcome?campaign=ad_abc123&utm_source=vk&ref=friend&yclid=42',
    });

    expect(first.status).toBe(302);
    expect(first.headers['location']).toBe('/welcome?utm_source=vk&ref=friend&yclid=42');
    expect(String(first.headers['set-cookie'] ?? '')).toMatch(/ad_code=abc123;/);
    expect(panel.recordClick).toHaveBeenCalledWith({ code: 'abc123', surface: 'WEB', utmSource: 'vk' });

    // The address the browser follows is the SPA, whose `/welcome` sends it on
    // to the sign-in form with the query whole (`web/test/welcome-alias.test.tsx`).
    const second = await sendSocketless(app, { method: 'GET', url: '/welcome?utm_source=vk&ref=friend&yclid=42' });
    expect(second.status).toBe(200);
    expect(text(second.body)).toContain('<div id="root">');
    expect(panel.getEffective).not.toHaveBeenCalled();
  });
});

/** The names the landing's code went by in 0.9.7.53. */
const RETIRED_NAMES = new Set([
  'LANDING_LKG',
  'LandingNamespace',
  'createLandingRouter',
  'getEffectiveLandingCached',
  'buildLandingMetaHead',
  'heldLandingVersion',
  'resetLandingCache',
]);

/**
 * What the CODE of one file says about the landing, read by the TypeScript
 * parser: comments are not code, and prose about the landing is allowed.
 *
 * Parsed, not regex-stripped. `stripComments` (`support/source-scan.ts`) takes
 * a `/*` inside a string for the start of a comment, and `app.ts` has one in
 * its CSP (`"https://*.telegram.org"`): the strip then swallowed the file from
 * there to the SPA routes — the very stretch a landing lookup lived in — and a
 * re-added `adminClient.landing.getEffective()` went unseen (mutant M4).
 */
function landingInCode(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node): string => `${fileName.replace(/\\/g, '/')}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'landing') {
      found.push(`${at(node)} reads \`.landing\``);
    } else if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.name.getText(source) === 'landing') {
      found.push(`${at(node)} declares \`landing\``);
    } else if (ts.isIdentifier(node) && RETIRED_NAMES.has(node.text)) {
      found.push(`${at(node)} names ${node.text}`);
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const value = node.text;
      if (value.includes('/api/internal/landing-config')) found.push(`${at(node)} calls the panel's landing route`);
      if (value.includes('reiwa:lkg:landing')) found.push(`${at(node)} spells the saved copy's key`);
      if (value === 'landing') found.push(`${at(node)} names a group or key \`landing\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the landing is gone from the code', () => {
  it('no code in src/ asks the panel for it, keeps a copy of it, or versions it', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles('src')) {
      scanned += 1;
      offenders.push(...landingInCode(file, readFileSync(file, 'utf8')));
    }

    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('the scan reads the code a comment strip could not — and finds a landing read in it', () => {
    // NON-VACUITY: the line 0.9.7.53 had, placed after a `/*` inside a string,
    // exactly as `app.ts` has one; and prose about it, which is not code.
    const sample = [
      'const csp = ["https://*.telegram.org"];',
      '// the landing lived here: adminClient.landing.getEffective()',
      'const body = await adminClient.landing.getEffective();',
      "const key = 'reiwa:lkg:landing:v1';",
      'const regex = /^\\/assets\\/.*/;',
    ].join('\n');
    expect(landingInCode('sample.ts', sample)).toEqual([
      "sample.ts:3 reads `.landing`",
      "sample.ts:4 spells the saved copy's key",
    ]);
    // And the neighbour of the same shape is read where it really lives.
    const connectPage = 'src/infrastructure/admin-client/namespaces/connect-page.ts';
    expect(readFileSync(connectPage, 'utf8')).toContain("'/api/internal/connect-page/effective'");
    expect(landingInCode(connectPage, readFileSync(connectPage, 'utf8'))).toEqual([]);
  });
});
