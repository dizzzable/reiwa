import express from 'express';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../../../src/core/errors/index.js';
import { createDevicesRouter } from '../../../src/api/routes/devices.js';

/**
 * GET /api/v1/devices and GET /api/v1/devices/subscription/:id.
 *
 * Both handlers used to answer `200 {"devices":[]}` on ANY failure —
 * byte-identical to a genuinely empty list. rezeis-admin now fails a bad panel
 * read loudly (503 outage / not-found, 502 unusable answer); if this router
 * swallows that, the cabinet can never tell a customer "we could not check"
 * apart from "you have none", and the upstream fix is inert for the only
 * audience it was written for.
 *
 * These specs pin the propagation. The success cases pin that nothing changed
 * for a read that worked.
 */

type DevicesFakes = {
  readonly list?: () => Promise<unknown>;
  readonly listForSubscription?: () => Promise<unknown>;
};

function makeApp(devices: DevicesFakes | null) {
  const app = express();
  // The router's session guard is not under test — stub a WebSession so the
  // request reaches the handler.
  app.use((req, _res, next) => {
    (req as { webSession?: { userId: string } }).webSession = { userId: 'user_1' };
    next();
  });
  app.use(
    '/api/v1/devices',
    createDevicesRouter({
      adminClient: devices === null ? null : ({ devices } as never),
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

const PANEL_LIST = {
  devices: [
    {
      hwid: 'hwid-1',
      platform: 'android',
      osVersion: '14',
      deviceModel: 'Pixel 8',
      userAgent: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      lastSeenAt: '2026-08-05T10:00:00.000Z',
    },
  ],
  total: 1,
};

const UPSTREAM_PATHS = [
  { label: 'legacy list', path: '/api/v1/devices', key: 'list' as const },
  {
    label: 'per-subscription list',
    path: '/api/v1/devices/subscription/sub_1',
    key: 'listForSubscription' as const,
  },
];

describe('devices list routes', () => {
  for (const { label, path, key } of UPSTREAM_PATHS) {
    describe(label, () => {
      it('forwards a successful read unchanged', async () => {
        const read = vi.fn(async () => PANEL_LIST);
        const res = await get(makeApp({ [key]: read }), path);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual(PANEL_LIST);
        expect(read).toHaveBeenCalledTimes(1);
      });

      it('forwards a genuinely empty list as an empty list', async () => {
        const res = await get(makeApp({ [key]: async () => ({ devices: [], total: 0 }) }), path);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ devices: [], total: 0 });
      });

      it('answers 503 (never an empty list) when upstream reports the panel unavailable', async () => {
        const res = await get(
          makeApp({
            [key]: async () => {
              throw new UpstreamError('GET', '/api/internal/user/u/devices', 503, 'panel down');
            },
          }),
          path,
        );
        expect(res.status).toBe(503);
        // The exact failure the customer must never see as "0 devices".
        expect(res.body).not.toContain('"devices"');
      });

      it('answers 502 when upstream could not trust the panel answer', async () => {
        const res = await get(
          makeApp({
            [key]: async () => {
              throw new UpstreamError('GET', '/api/internal/user/u/devices', 502, 'invalid');
            },
          }),
          path,
        );
        expect(res.status).toBe(502);
        expect(res.body).not.toContain('"devices"');
      });

      it('answers 503 on a transport failure with no upstream status', async () => {
        const res = await get(
          makeApp({
            [key]: async () => {
              throw new Error('ECONNRESET');
            },
          }),
          path,
        );
        expect(res.status).toBe(503);
        expect(res.body).not.toContain('"devices"');
      });

      it('answers 502 for a payload with no devices array (not an empty list)', async () => {
        const res = await get(makeApp({ [key]: async () => ({ unexpected: true }) }), path);
        expect(res.status).toBe(502);
        expect(res.body).not.toContain('"devices"');
      });

      it('answers 503 when no admin client is configured', async () => {
        const res = await get(makeApp(null), path);
        expect(res.status).toBe(503);
        expect(res.body).not.toContain('"devices"');
      });

      it('never leaks the internal upstream path or body to the browser', async () => {
        const res = await get(
          makeApp({
            [key]: async () => {
              throw new UpstreamError(
                'GET',
                '/api/internal/user/u/devices',
                503,
                'remnawave says: token expired',
              );
            },
          }),
          path,
        );
        expect(res.body).not.toContain('/api/internal');
        expect(res.body).not.toContain('remnawave');
      });
    });
  }
});
