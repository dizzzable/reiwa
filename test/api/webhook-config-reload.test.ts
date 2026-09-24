import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBrandingCache } from '../../src/api/routes/branding.js';
import { resetConnectPageCache } from '../../src/api/routes/connect-page.js';
import { resetLandingCache } from '../../src/api/routes/landing.js';
import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';
import { setPolicyCache } from '../../src/infrastructure/admin-client/policy-cache.js';
import type { ConfigVersionKey } from '../../src/infrastructure/config-versions/config-version.js';
import type { VersionedGroup } from '../../src/infrastructure/config-versions/poller.js';
import { sendSocketless } from './socketless-request.js';

/**
 * What the panel's settings webhook does beyond dropping the caches:
 *  - it re-reads each group it named through the version poll's own adapters,
 *    so the copy — and the version the cabinet reports — moves to the save at
 *    once;
 *  - it leaves the on-disk logo mirror alone (W8 report D7).
 */

const WEBHOOK_SECRET = 'webhook-secret-for-reload';

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

const ALL_KEYS: readonly ConfigVersionKey[] = [
  'publicConfig',
  'customEmojiPacks',
  'landing',
  'connectPage',
  'platformPolicy',
  'guestSupport',
];

function buildApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as { rawBody?: Buffer }).rawBody = buffer;
      },
    }),
  );
  const reset = vi.fn<(key: ConfigVersionKey) => void>();
  const reload = vi.fn<(key: ConfigVersionKey) => void>();
  const groups: VersionedGroup[] = ALL_KEYS.map((key) => ({
    key,
    held: () => null,
    reset: () => reset(key),
    reload: () => reload(key),
  }));
  app.locals['configVersionGroups'] = groups;
  app.locals['adminClient'] = null;
  app.use(
    '/api/v1',
    createRezeisWebhookRouter({
      config: {
        REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
        REIWA_BOT_INTERNAL_URL: 'http://reiwa-bot:5100',
        REZEIS_INTERNAL_SHARED_SECRET: 's'.repeat(32),
      } as never,
    }),
  );
  return { app, reset, reload };
}

async function hint(app: express.Express, event: string): Promise<number> {
  const body = { event, metadata: { reason: 'operator-save' } };
  const res = await sendSocketless(app, {
    method: 'POST',
    url: '/api/v1/webhooks/rezeis',
    headers: { 'x-rezeis-signature': sign(JSON.stringify(body)) },
    body,
  });
  return res.status;
}

function resetAll(): void {
  resetBrandingCache();
  resetLandingCache();
  resetConnectPageCache();
  setPolicyCache(null);
}

describe('the settings webhook re-reads what it drops', () => {
  beforeEach(resetAll);
  afterEach(() => {
    resetAll();
    vi.restoreAllMocks();
  });

  it.each([
    { event: 'reiwa.branding.invalidate', keys: ['publicConfig', 'customEmojiPacks'] },
    { event: 'reiwa.landing.invalidate', keys: ['landing'] },
    { event: 'reiwa.connect-page.invalidate', keys: ['connectPage'] },
    { event: 'reiwa.platform.policy_invalidated', keys: ['platformPolicy', 'publicConfig', 'customEmojiPacks'] },
  ] as const)('$event: the groups it names, and no other', async ({ event, keys }) => {
    // Only the policy event dials the bot; nothing here may reach a real one.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { app, reset, reload } = buildApp();

    expect(await hint(app, event)).toBe(204);

    expect(reload.mock.calls.map(([key]) => key).sort()).toEqual([...keys].sort());
    expect(reset.mock.calls.map(([key]) => key).sort()).toEqual([...keys].sort());
  });

  it('an unsigned call re-reads nothing', async () => {
    const { app, reload } = buildApp();
    const body = { event: 'reiwa.branding.invalidate', metadata: {} };
    const res = await sendSocketless(app, { method: 'POST', url: '/api/v1/webhooks/rezeis', body });
    expect(res.status).toBe(401);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the on-disk logo mirror across a branding save (W8 report D7)', () => {
  const previous = process.env['BRANDING_CACHE_DIR'];
  const dir = mkdtempSync(join(tmpdir(), 'reiwa-branding-mirror-'));

  beforeAll(() => {
    process.env['BRANDING_CACHE_DIR'] = dir;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['BRANDING_CACHE_DIR'];
    else process.env['BRANDING_CACHE_DIR'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('is left alone: a panel outage right after any branding save keeps the operator’s logo', async () => {
    // Upload names are unique (`/uploads/branding/<random>.<ext>`), so a new
    // logo is a new file; wiping the mirror bought nothing and, with the panel
    // down after the save, turned the logo into the stock Reiwa icon.
    const logo = join(dir, '3f2a9c0d1e5b4a7c8d9e0f1a2b3c4d5e.png');
    writeFileSync(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { app } = buildApp();

    expect(await hint(app, 'reiwa.branding.invalidate')).toBe(204);
    // The wipe was fire-and-forget: give one a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(logo)).toBe(true);
  });
});
