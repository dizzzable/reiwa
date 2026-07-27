import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';

async function get(app: ReturnType<typeof createApp>, requestPath: string): Promise<{
  readonly status: number;
  readonly body: string;
}> {
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

describe('single-image SPA assets', () => {
  it('returns a real 404 for a missing hashed asset instead of the SPA document', async () => {
    const webDist = await mkdtemp(path.join(os.tmpdir(), 'reiwa-static-assets-'));
    const previousWebDist = process.env.REIWA_WEB_DIST;
    try {
      await writeFile(webDist + path.sep + 'index.html', '<!doctype html><title>Reiwa</title>');
      process.env.REIWA_WEB_DIST = webDist;
      const app = createApp({
        adminClient: null,
        sessionStore: null,
        webSessionStore: null,
        config: {
          NODE_ENV: 'test',
          REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
        } as never,
      });

      const missingAsset = await get(app, '/assets/web-home-page-DSlEAZwx.js');
      const clientRoute = await get(app, '/dashboard');

      expect(missingAsset).toEqual({ status: 404, body: '' });
      expect(clientRoute).toEqual({ status: 200, body: '<!doctype html><title>Reiwa</title>' });
    } finally {
      if (previousWebDist === undefined) delete process.env.REIWA_WEB_DIST;
      else process.env.REIWA_WEB_DIST = previousWebDist;
      await rm(webDist, { recursive: true, force: true });
    }
  });
});
