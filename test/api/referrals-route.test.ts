import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createReferralsRouter } from '../../src/api/routes/referrals.js';

function makeApp(exchangePoints: (identity: Record<string, unknown>, body: Record<string, unknown>) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // `WebSession` also carries the bookkeeping the store maintains; the route
    // only reads `userId`, but the shape has to be whole.
    req.webSession = { userId: 'user-cuid-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    next();
  });
  app.use('/api/v1', createReferralsRouter({
    adminClient: {
      referrals: {
        exchangePoints,
      },
    } as never,
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

describe('referrals exchange route', () => {
  it('forwards subscriptionId and idempotencyKey to the admin client', async () => {
    const exchangePoints = vi.fn(async () => ({ success: true }));
    const response = await post(makeApp(exchangePoints), '/api/v1/referrals/exchange', {
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
    const response = await post(makeApp(exchangePoints), '/api/v1/referrals/exchange', {
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
