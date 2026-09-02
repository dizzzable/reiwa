import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createReferralsRouter } from '../../src/api/routes/referrals.js';
import { UpstreamError } from '../../src/core/errors/index.js';

function makeApp(referrals: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // `WebSession` also carries the bookkeeping the store maintains; the route
    // only reads `userId`, but the shape has to be whole.
    req.webSession = { userId: 'user-cuid-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    next();
  });
  app.use('/api/v1', createReferralsRouter({
    adminClient: { referrals } as never,
    sessionStore: null,
    config: {} as never,
  }));
  return app;
}

async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify(body);

  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: data.length > 0 ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    server.close();
  }
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data.length > 0 ? JSON.parse(data) : null,
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe('referrals exchange route', () => {
  it('forwards subscriptionId and idempotencyKey to the admin client', async () => {
    const exchangePoints = vi.fn(async () => ({ success: true }));
    const response = await post(makeApp({ exchangePoints }), '/api/v1/referrals/exchange', {
      type: 'SUBSCRIPTION_DAYS',
      points: 240,
      subscriptionId: 'sub_123',
      idempotencyKey: 'intent_abc',
    });

    expect(response.status).toBe(200);
    expect(exchangePoints).toHaveBeenCalledWith(
      { userId: 'user-cuid-1' },
      {
        type: 'SUBSCRIPTION_DAYS',
        points: 240,
        subscriptionId: 'sub_123',
        idempotencyKey: 'intent_abc',
      },
    );
  });

  it('normalizes upstream error payloads into success=false for the web client', async () => {
    const exchangePoints = vi.fn(async () => ({ error: 'NOT_ENOUGH_POINTS' }));
    const response = await post(makeApp({ exchangePoints }), '/api/v1/referrals/exchange', {
      type: 'SUBSCRIPTION_DAYS',
      points: 240,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: false,
      error: 'NOT_ENOUGH_POINTS',
    });
  });
});

describe('referrals points ledger route', () => {
  it('forwards the keyset cursor and limit, and returns the page as-is', async () => {
    const getPointsLedger = vi.fn(async () => ({ items: [{ id: 'l1' }], nextCursor: 'c2' }));
    const response = await get(
      makeApp({ getPointsLedger }),
      '/api/v1/referrals/points/ledger?cursor=c1&limit=5',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [{ id: 'l1' }], nextCursor: 'c2' });
    expect(getPointsLedger).toHaveBeenCalledWith({ userId: 'user-cuid-1' }, 'c1', 5);
  });

  it('sends no cursor for the first page', async () => {
    // An empty `?cursor=` is not "start from the top" upstream — it is a
    // cursor that points nowhere. The first page must ask without one.
    const getPointsLedger = vi.fn(async () => ({ items: [], nextCursor: null }));
    await get(makeApp({ getPointsLedger }), '/api/v1/referrals/points/ledger?cursor=');

    expect(getPointsLedger).toHaveBeenCalledWith({ userId: 'user-cuid-1' }, undefined, 20);
  });

  it('passes an upstream 404 through as 404 — that is how the SPA reads "older panel"', async () => {
    // Collapsing this into an empty 200 would tell every customer on an
    // older panel that they have earned nothing, which is a different
    // statement from "this install cannot answer".
    const getPointsLedger = vi.fn(async () => {
      throw new UpstreamError('GET', '/api/internal/user/u/referrals/points/ledger', 404, 'Not Found');
    });
    const response = await get(makeApp({ getPointsLedger }), '/api/v1/referrals/points/ledger');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Points history not available' });
  });

  it('keeps a real upstream failure a 500', async () => {
    const getPointsLedger = vi.fn(async () => {
      throw new UpstreamError('GET', '/api/internal/user/u/referrals/points/ledger', 500, 'boom');
    });
    const response = await get(makeApp({ getPointsLedger }), '/api/v1/referrals/points/ledger');

    expect(response.status).toBe(500);
    // The upstream body carries provider diagnostics; only the safe line ships.
    expect(response.body).toEqual({ message: 'Failed to load points history' });
  });
});
