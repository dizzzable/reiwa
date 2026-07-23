import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import express from 'express';

import {
  createBrandingRouter,
  resetBrandingCache,
} from '../../src/api/routes/branding.js';

async function request(app: express.Express, path: string): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      http.get(`http://127.0.0.1:${address.port}${path}`, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          server.close();
          resolve({
            status: response.statusCode ?? 500,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        });
      }).on('error', (error) => {
        server.close();
        reject(error);
      });
    });
  });
}

describe('GET /api/v1/public-config', () => {
  it('publishes the Reiwa-owned targets used by advertising deep links', async () => {
    resetBrandingCache();
    const app = express();
    app.use(
      '/api/v1',
      createBrandingRouter({
        adminClient: null,
        botUsername: '@ReiwaBot',
        webBaseUrl: 'https://reiwa.example/',
      }),
    );

    const response = await request(app, '/api/v1/public-config');

    assert.equal(response.status, 200);
    assert.equal(response.body.botUsername, 'ReiwaBot');
    assert.equal(response.body.webBaseUrl, 'https://reiwa.example');
  });
});
