/**
 * A NEW CABINET BESIDE AN OLD PANEL KEEPS WORKING (pair design D1 §9, "new
 * cabinet + previous panel").
 *
 * The cabinet now sends two headers on every call and reads a `panel` block
 * from the version poll's answer. A panel that predates both must see nothing
 * it can refuse:
 *
 *  - no new field in any body. The panel validates bodies with
 *    `forbidNonWhitelisted`, and the heartbeat's DTO is strict: an extra field
 *    is a 400 for the whole call;
 *  - the heartbeat and the poll still answer 200, and the HMAC still verifies;
 *  - an answer without the block (0.9.7.70) and a 404 on the poll (0.9.7.69)
 *    are both kept as a legacy panel, and each is logged once.
 *
 * The fake panels below answer the way those releases do; unknown headers are
 * simply not read, as in any HTTP server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { REIWA_VERSION } from '../../src/core/version.js';
import { AdminClient } from '../../src/infrastructure/admin-client/index.js';
import {
  RedisPanelCapabilities,
  panelRecorder,
} from '../../src/infrastructure/config-versions/panel-capabilities.js';
import { ConfigVersionPoller } from '../../src/infrastructure/config-versions/poller.js';
import { verifyInternalSignature } from '../../src/lib/internal-hmac.js';

const SECRET = 'shared-secret';
const TOKEN = 'internal-token';
const V = 'a'.repeat(32);

/** `ReportReiwaVersionDto` on panel 0.9.7.70, with `whitelist + forbidNonWhitelisted`. */
const HEARTBEAT_VERSION = /^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;

interface Call {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface FakePanel {
  readonly url: string;
  readonly calls: Call[];
  close(): Promise<void>;
}

type Release = '0.9.7.70' | '0.9.7.69' | '0.9.7.71';

/**
 * A panel of `release()` — a function, so a test can roll it back mid-run.
 * Every route checks the bearer token and the signature, as
 * `InternalAdminAuthGuard` does.
 */
async function startPanel(release: () => Release): Promise<FakePanel> {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const method = req.method ?? 'GET';
      const path = req.url ?? '';
      const answer = (status: number, body: unknown): void => {
        let parsed: unknown = null;
        try {
          parsed = raw.length > 0 ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        calls.push({ method, path, status, body: parsed, headers: req.headers });
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };

      const signed = verifyInternalSignature({
        secret: SECRET,
        method,
        path,
        body: raw,
        timestamp: req.headers['x-request-timestamp'] as string | undefined,
        signature: req.headers['x-request-signature'] as string | undefined,
      });
      if (req.headers.authorization !== `Bearer ${TOKEN}` || !signed) {
        answer(401, { message: 'Unauthorized' });
        return;
      }

      if (method === 'POST' && path === '/api/internal/system/reiwa-version') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const strict =
          Object.keys(body).length === 1 &&
          typeof body['version'] === 'string' &&
          body['version'].length <= 32 &&
          HEARTBEAT_VERSION.test(body['version']);
        if (!strict) answer(400, { message: ['property … should not exist'] });
        else answer(200, { ok: true });
        return;
      }
      if (method === 'POST' && path === '/api/internal/config-versions') {
        const current = release();
        if (current === '0.9.7.69') {
          answer(404, { message: 'Cannot POST /api/internal/config-versions' });
          return;
        }
        const versions = { publicConfig: V };
        if (current === '0.9.7.71') {
          answer(200, { versions, panel: { version: '0.9.7.71', capabilities: ['panel.cabinet-peers'] } });
        } else {
          answer(200, { versions });
        }
        return;
      }
      answer(404, { message: `Cannot ${method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A Redis string store in memory. */
function fakeRedis() {
  const values = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** reiwa-api as `api/main.ts` wires it: its client, its poll, what it keeps. */
async function cabinetAgainst(release: () => Release) {
  const panel = await startPanel(release);
  cleanup.push(() => panel.close());
  const client = new AdminClient(panel.url, TOKEN, SECRET, { surface: 'api' });
  cleanup.push(() => client.close());
  const store = new RedisPanelCapabilities({ redis: fakeRedis() as never });
  const log = logger();
  const poller = new ConfigVersionPoller({
    consumer: 'api',
    groups: [{ key: 'publicConfig', held: () => V, reset: () => undefined, reload: () => undefined }],
    poll: (report) => client.system.pollConfigVersions(report),
    onPanel: panelRecorder(store, { consumer: 'api', logger: log as never }),
    logger: log as never,
  });
  return { panel, client, store, log, poller };
}

describe('beside panel 0.9.7.70: the poll answers without a panel block', () => {
  it('the heartbeat passes the strict DTO: its body is { version } and nothing else', async () => {
    const { panel, client } = await cabinetAgainst(() => '0.9.7.70');

    await expect(client.system.reportReiwaVersion(REIWA_VERSION)).resolves.toEqual({ ok: true });

    const [heartbeat] = panel.calls;
    expect(heartbeat).toMatchObject({ status: 200, body: { version: REIWA_VERSION } });
    expect(Object.keys(heartbeat!.body as object)).toEqual(['version']);
    // The identity went in the headers, where an older panel does not look.
    expect(heartbeat!.headers['x-reiwa-client']).toMatch(/^surface=api; /);
  });

  it('the poll answers 200 with its body unchanged, and the panel is kept as legacy, logged once', async () => {
    const { panel, store, log, poller } = await cabinetAgainst(() => '0.9.7.70');

    await poller.tick();
    await poller.tick();

    expect(panel.calls.map((call) => call.status)).toEqual([200, 200]);
    for (const call of panel.calls) {
      expect(Object.keys(call.body as object)).toEqual(['consumer', 'held']);
      expect(call.body).toEqual({ consumer: 'api', held: { publicConfig: V } });
    }
    expect(await store.read()).toMatchObject({ kind: 'legacy', version: null, capabilities: [] });
    expect(await store.can('panel.cabinet-peers')).toBe(false);
    const said = log.info.mock.calls.filter(([, message]) => String(message).startsWith('panel capabilities:'));
    expect(said).toHaveLength(1);
    expect(said[0]![1]).toContain('does not say what it can do');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('no call is refused: nothing 4xx in the panel’s log', async () => {
    const { panel, client, poller } = await cabinetAgainst(() => '0.9.7.70');
    await client.system.reportReiwaVersion(REIWA_VERSION);
    await poller.tick();
    expect(panel.calls.length).toBe(2);
    expect(panel.calls.filter((call) => call.status >= 400)).toEqual([]);
  });
});

describe('beside panel 0.9.7.69: the poll itself is a 404', () => {
  it('the heartbeat still answers 200, and the panel is kept as legacy', async () => {
    const { panel, client, store, poller } = await cabinetAgainst(() => '0.9.7.69');

    await client.system.reportReiwaVersion(REIWA_VERSION);
    await poller.tick();

    expect(panel.calls.map((call) => [call.path, call.status])).toEqual([
      ['/api/internal/system/reiwa-version', 200],
      ['/api/internal/config-versions', 404],
    ]);
    expect(await store.read()).toMatchObject({ kind: 'legacy', capabilities: [] });
  });
});

describe('a panel 0.9.7.71 rolled back to 0.9.7.70', () => {
  it('keeps nothing of the newer panel after the next poll', async () => {
    let release: Release = '0.9.7.71';
    const { store, poller } = await cabinetAgainst(() => release);

    await poller.tick();
    expect(await store.read()).toMatchObject({ kind: 'declared', version: '0.9.7.71' });
    expect(await store.can('panel.cabinet-peers')).toBe(true);

    release = '0.9.7.70';
    await poller.tick();
    expect(await store.read()).toMatchObject({ kind: 'legacy', capabilities: [] });
    expect(await store.can('panel.cabinet-peers')).toBe(false);
  });
});
