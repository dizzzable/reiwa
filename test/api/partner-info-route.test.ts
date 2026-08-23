import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createPartnerRouter } from '../../src/api/routes/partner.js';

/**
 * `GET /api/v1/partner/info` — the BFF hop between the panel and the cabinet.
 *
 * The partner payload now carries `referralPoints`: the referral points a
 * subscriber earned BEFORE the owner appointed them a partner. They accrue no
 * more of them, but the ones they have stay spendable — and since the Partner
 * tab replaced the Referral tab in the cabinet's single nav slot, this payload
 * is what lets the partner page say the number and offer the exchange.
 *
 * This route is a relay, and this spec pins that it stays one. A field
 * allowlist or a hand-rolled projection added here would silently strip the
 * points on their way through, and both surfaces would then render exactly
 * what they render for a partner who has none — nothing at all.
 *
 * `0` matters as much as `40`: the panel deliberately sends the number even at
 * zero, because whether it is SHOWN is the surface's rule, not the wire's.
 */

function makeApp(getInfo: (identity: Record<string, unknown>) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = { userId: 'user-cuid-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    next();
  });
  app.use(
    '/api/v1',
    createPartnerRouter({
      adminClient: { partner: { getInfo } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
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

/** Relative, never an absolute literal: a fixture date in this ecosystem was
 *  live when written and silently became an expired-subscription assertion
 *  months later. Nothing here asserts on time; the string is only relayed. */
const APPOINTED_AT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const PANEL_PAYLOAD = {
  id: 'partner-1',
  isActive: true,
  balance: 12_345,
  totalEarned: 20_000,
  totalWithdrawn: 0,
  programAvailable: true,
  balancePaymentEnabled: false,
  balanceCurrency: 'RUB',
  referralPoints: 40,
  createdAt: APPOINTED_AT,
};

describe('partner info route', () => {
  it('relays the panel payload verbatim, referral points included', async () => {
    const getInfo = vi.fn(async () => PANEL_PAYLOAD);

    const response = await get(makeApp(getInfo), '/api/v1/partner/info');

    expect(response.status).toBe(200);
    // Verbatim, key for key: the relay adds nothing and drops nothing.
    expect(response.body).toEqual(PANEL_PAYLOAD);
    expect(getInfo).toHaveBeenCalledWith({ userId: 'user-cuid-1' });
  });

  it('relays a zero rather than collapsing it into a missing field', async () => {
    // Zero and absent mean different things downstream: zero is a fact the
    // panel vouches for, absent is a panel too old to have the field at all.
    const getInfo = vi.fn(async () => ({ ...PANEL_PAYLOAD, referralPoints: 0 }));

    const response = await get(makeApp(getInfo), '/api/v1/partner/info');

    const body = response.body as Record<string, unknown>;
    expect(Object.keys(body)).toContain('referralPoints');
    expect(body['referralPoints']).toBe(0);
  });

  it('passes an older panel through unchanged, inventing no points', async () => {
    const { referralPoints: _omitted, ...withoutPoints } = PANEL_PAYLOAD;
    const getInfo = vi.fn(async () => withoutPoints);

    const response = await get(makeApp(getInfo), '/api/v1/partner/info');

    const body = response.body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('referralPoints');
    expect(body['balance']).toBe(12_345);
  });
});
