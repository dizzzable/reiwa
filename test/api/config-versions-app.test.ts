import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { resetBrandingCache } from '../../src/api/routes/branding.js';
import { resetConnectPageCache } from '../../src/api/routes/connect-page.js';
import { resetLandingCache } from '../../src/api/routes/landing.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import { configVersionOf } from '../../src/infrastructure/config-versions/config-version.js';
import type { VersionedGroup } from '../../src/infrastructure/config-versions/poller.js';
import { sendSocketless } from './socketless-request.js';

/**
 * The API's settings groups as the composition root wires them: the adapters
 * the version poll and the webhook share, and `GET /api/v1/config-versions`,
 * the route open pages read to notice a change without a reload.
 */

const WEBHOOK_SECRET = 'webhook-secret-for-config-versions';

const LANDING_BEFORE = { enabled: true, schemaVersion: 1, sections: [], revision: 'before-publish' };
const LANDING_AFTER = { enabled: true, schemaVersion: 1, sections: [], revision: 'published' };

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function buildApp() {
  let landing: unknown = LANDING_BEFORE;
  const getEffective = vi.fn(async () => landing);
  const app = createApp({
    adminClient: { landing: { getEffective } } as never,
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
  return {
    app,
    getEffective,
    publish: (next: unknown) => {
      landing = next;
    },
  };
}

async function versions(app: unknown): Promise<{ headers: Record<string, unknown>; versions: Record<string, unknown> }> {
  const res = await sendSocketless(app, { method: 'GET', url: '/api/v1/config-versions' });
  expect(res.status).toBe(200);
  return {
    headers: res.headers as Record<string, unknown>,
    versions: (res.body as { versions: Record<string, unknown> }).versions,
  };
}

function resetAll(): void {
  resetBrandingCache();
  resetLandingCache();
  resetConnectPageCache();
  setPolicyCache(null);
}

describe('the API process’s settings versions', () => {
  beforeEach(resetAll);
  afterEach(() => {
    resetAll();
    vi.restoreAllMocks();
  });

  it('hands the poll one adapter per group the API serves', () => {
    const { app } = buildApp();
    const groups = app.locals['configVersionGroups'] as readonly VersionedGroup[];
    expect(groups.map((group) => group.key).sort()).toEqual([
      'connectPage',
      'customEmojiPacks',
      'guestSupport',
      'landing',
      'platformPolicy',
      'publicConfig',
    ]);
  });

  it('GET /api/v1/config-versions: what is held, from memory, never cached by the browser', async () => {
    const { app } = buildApp();

    const cold = await versions(app);
    expect(cold.headers['cache-control']).toBe('no-store');
    expect(cold.versions).toEqual({
      publicConfig: null,
      customEmojiPacks: null,
      landing: null,
      connectPage: null,
      platformPolicy: null,
      guestSupport: null,
    });

    await sendSocketless(app, { method: 'GET', url: '/api/v1/landing' });
    expect((await versions(app)).versions['landing']).toBe(configVersionOf(LANDING_BEFORE));
  });

  it('after a publish hint the version moves with no visitor asking — what an open page watches for', async () => {
    const { app, getEffective, publish } = buildApp();
    await sendSocketless(app, { method: 'GET', url: '/api/v1/landing' });
    expect(getEffective).toHaveBeenCalledTimes(1);

    publish(LANDING_AFTER);
    const body = { event: 'reiwa.landing.invalidate', metadata: { reason: 'publish' } };
    const hint = await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/webhooks/rezeis',
      headers: { 'x-rezeis-signature': sign(JSON.stringify(body)) },
      body,
    });
    expect(hint.status).toBe(204);

    await vi.waitFor(async () => {
      expect((await versions(app)).versions['landing']).toBe(configVersionOf(LANDING_AFTER));
    });
    expect(getEffective).toHaveBeenCalledTimes(2);
  });
});

/**
 * The key of latest versions (`config-versions/latest.ts`) as the composition
 * root wires it: on the web sessions' Redis — reiwa's own, shared with the bot —
 * where the settings webhook marks a bot save, and the API's poll writes what
 * the panel said (`api/main.ts`, `onVersions`).
 */
describe('the API process’s part of the key of latest versions', () => {
  beforeEach(resetAll);
  afterEach(() => {
    resetAll();
    vi.restoreAllMocks();
  });

  function redisDouble() {
    const hashes = new Map<string, Map<string, string>>();
    const strings = new Map<string, string>();
    return {
      hashes,
      redis: {
        hset: vi.fn(async (key: string, fields: Record<string, string>) => {
          const hash = hashes.get(key) ?? new Map<string, string>();
          for (const [field, value] of Object.entries(fields)) hash.set(field, value);
          hashes.set(key, hash);
          return 1;
        }),
        hgetall: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map<string, string>())),
        get: vi.fn(async (key: string) => strings.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
          strings.set(key, value);
          return 'OK';
        }),
        del: vi.fn(async () => 0),
      },
    };
  }

  it('a bot save the webhook relays is marked in reiwa’s Redis, where the bot reads it', async () => {
    const { redis, hashes } = redisDouble();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const app = createApp({
      adminClient: null,
      sessionStore: null,
      webSessionStore: { getRedis: () => redis } as never,
      config: {
        NODE_ENV: 'test',
        REIWA_COOKIE_SECURE: false,
        REIWA_ALLOW_INSECURE_COOKIES: true,
        REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
        REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
        REZEIS_INTERNAL_SHARED_SECRET: 's'.repeat(32),
      } as never,
    });

    const body = { event: 'reiwa.bot.invalidate', metadata: { reason: 'operator-save' } };
    const res = await sendSocketless(app, {
      method: 'POST',
      url: '/api/v1/webhooks/rezeis',
      headers: { 'x-rezeis-signature': sign(JSON.stringify(body)) },
      body,
    });
    expect(res.status).toBe(204);

    await vi.waitFor(() => expect(hashes.get('reiwa:config-versions:latest:v1')?.has('hint:botConfig')).toBe(true));
    const at = Number(hashes.get('reiwa:config-versions:latest:v1')?.get('hint:botConfig'));
    expect(Math.abs(Date.now() - at)).toBeLessThan(5_000);
  });

  it('the API’s poll hands its answers to that key', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/api/main.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain(
      'onVersions: (versions, answeredAt) => void latestConfigVersions?.recordPoll(versions, answeredAt),',
    );
    expect(source).toContain('const latestConfigVersions = app.locals["latestConfigVersions"]');
  });
});
