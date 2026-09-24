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
