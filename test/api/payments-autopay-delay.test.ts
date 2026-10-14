import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPaymentsRouter, readShownAutopayDelay } from '../../src/api/routes/payments.js';
import { createPlansRouter } from '../../src/api/routes/plans.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';
import { PaymentsNamespace } from '../../src/infrastructure/admin-client/namespaces/payments.js';

/**
 * «Отсрочка первого списания по СБП»: the delay the customer was shown travels
 * from the page through this route and the admin client to the panel, exactly as
 * the panel's own list named it — and nothing made up on the way. The panel
 * makes the checkout with that delay or refuses it, so a value that is not one
 * (a unit in the wrong case, a count that is not a whole number of days' worth)
 * is dropped here and never reaches it.
 *
 * And the list of gateways asks the panel about the customer, because the delay
 * is given once per customer.
 */

const createCheckout = vi.fn();
const createRenewalCheckout = vi.fn();
const getEnabledGateways = vi.fn();

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = { userId: 'user-cuid-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    next();
  });
  app.use(
    '/api/v1',
    createPaymentsRouter({
      adminClient: { payments: { createCheckout, createRenewalCheckout } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  app.use(
    '/api/v1',
    createPlansRouter({
      adminClient: { payments: { getEnabledGateways } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer(makeApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  createCheckout.mockReset();
  createRenewalCheckout.mockReset();
  getEnabledGateways.mockReset();
});

function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers:
          raw === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data.length > 0 ? JSON.parse(data) : null, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

const checkoutBody = (extra: Record<string, unknown>) => ({
  planId: 'plan-p',
  durationDays: 30,
  gatewayType: 'ANTILOPAY',
  purchaseType: 'NEW',
  savePaymentMethodConsent: true,
  autopayMethod: 'SBP',
  ...extra,
});

const renewalBody = (extra: Record<string, unknown>) => ({
  subscriptionIds: ['sub-1'],
  gatewayType: 'ANTILOPAY',
  savePaymentMethodConsent: true,
  autopayMethod: 'SBP',
  ...extra,
});

const WORDS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;

describe('reading the delay the page sends', () => {
  it.each(WORDS)('reads a count and %s', (unit) => {
    expect(readShownAutopayDelay({ autopayDelayCount: 2, autopayDelayUnit: unit })).toEqual({ count: 2, unit });
  });

  it.each([
    [{ autopayDelayCount: 7, autopayDelayUnit: 'day' }],
    [{ autopayDelayCount: 7, autopayDelayUnit: 'Day' }],
    [{ autopayDelayCount: 7, autopayDelayUnit: 'HOUR' }],
    [{ autopayDelayCount: 7 }],
    [{ autopayDelayUnit: 'DAY' }],
    [{ autopayDelayCount: 0, autopayDelayUnit: 'DAY' }],
    [{ autopayDelayCount: -1, autopayDelayUnit: 'DAY' }],
    [{ autopayDelayCount: 367, autopayDelayUnit: 'DAY' }],
    [{ autopayDelayCount: 1.5, autopayDelayUnit: 'DAY' }],
    [{ autopayDelayCount: '7', autopayDelayUnit: 'DAY' }],
    [{ autopayDelayCount: null, autopayDelayUnit: null }],
    [{}],
  ])('reads nothing from %j', (body) => {
    expect(readShownAutopayDelay(body)).toBeUndefined();
  });
});

describe('POST /payments/checkout — the delay the customer was shown', () => {
  it('forwards it to the panel beside the method and the consent', async () => {
    createCheckout.mockResolvedValueOnce({ paymentId: 'p-1' });

    const response = await request('POST', '/api/v1/payments/checkout', checkoutBody({ autopayDelayCount: 7, autopayDelayUnit: 'DAY' }));

    expect(response.status).toBe(200);
    const options = createCheckout.mock.calls[0]?.[5] as Record<string, unknown>;
    expect(options['autopayDelay']).toEqual({ count: 7, unit: 'DAY' });
    expect(options['autopayMethod']).toBe('SBP');
    expect(options['savePaymentMethodConsent']).toBe(true);
  });

  it('forwards nothing for a checkout that was shown none, and drops a delay it cannot read', async () => {
    createCheckout.mockResolvedValue({ paymentId: 'p-1' });

    await request('POST', '/api/v1/payments/checkout', checkoutBody({}));
    await request('POST', '/api/v1/payments/checkout', checkoutBody({ autopayDelayCount: 7, autopayDelayUnit: 'day' }));
    await request('POST', '/api/v1/payments/checkout', checkoutBody({ autopayDelayCount: 7 }));

    for (const call of createCheckout.mock.calls) {
      expect('autopayDelay' in (call[5] as Record<string, unknown>)).toBe(false);
    }
  });

  it('answers the panel\'s DELAY_CHANGED with its reason, so the page can tell the customer what changed', async () => {
    createCheckout.mockRejectedValueOnce(
      new UpstreamError(
        'POST',
        '/api/internal/payments/checkout',
        400,
        JSON.stringify({
          statusCode: 400,
          message: 'Automatic charging is not available for this purchase.',
          errorCode: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
          code: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
          reason: 'DELAY_CHANGED',
        }),
      ),
    );

    const response = await request('POST', '/api/v1/payments/checkout', checkoutBody({ autopayDelayCount: 7, autopayDelayUnit: 'DAY' }));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      message: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      reason: 'DELAY_CHANGED',
    });
  });
});

describe('POST /payments/renewal-checkout — the delay the customer was shown', () => {
  it('forwards it, and drops one it cannot read', async () => {
    createRenewalCheckout.mockResolvedValue({ paymentId: 'p-2' });

    await request('POST', '/api/v1/payments/renewal-checkout', renewalBody({ autopayDelayCount: 2, autopayDelayUnit: 'WEEK' }));
    await request('POST', '/api/v1/payments/renewal-checkout', renewalBody({ autopayDelayCount: 2, autopayDelayUnit: 'week' }));
    await request('POST', '/api/v1/payments/renewal-checkout', renewalBody({}));

    expect((createRenewalCheckout.mock.calls[0]?.[1] as Record<string, unknown>)['autopayDelay']).toEqual({ count: 2, unit: 'WEEK' });
    expect('autopayDelay' in (createRenewalCheckout.mock.calls[1]?.[1] as Record<string, unknown>)).toBe(false);
    expect('autopayDelay' in (createRenewalCheckout.mock.calls[2]?.[1] as Record<string, unknown>)).toBe(false);
  });
});

describe('GET /gateways — the list names the customer', () => {
  it('asks the panel about the signed-in customer and keeps the answer from anybody else', async () => {
    getEnabledGateways.mockResolvedValueOnce([{ type: 'ANTILOPAY', autopayDelay: { count: 7, unit: 'DAY', days: 7 } }]);

    const response = await request('GET', '/api/v1/gateways');

    expect(response.status).toBe(200);
    expect(getEnabledGateways).toHaveBeenCalledWith('WEB', 'user-cuid-1');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual([{ type: 'ANTILOPAY', autopayDelay: { count: 7, unit: 'DAY', days: 7 } }]);
  });
});

describe('the admin client', () => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      return {};
    },
  };
  const namespace = new PaymentsNamespace(transport as never);

  afterEach(() => {
    calls.length = 0;
  });

  it('puts the delay on the internal checkout and renewal-checkout bodies as a count and a word', async () => {
    await namespace.createCheckout({ userId: 'user-1' }, 'NEW', 'plan-1', 30, 'ANTILOPAY', {
      savePaymentMethodConsent: true,
      autopayMethod: 'SBP',
      autopayDelay: { count: 7, unit: 'DAY' },
    });
    await namespace.createCheckout({ userId: 'user-1' }, 'NEW', 'plan-1', 30, 'ANTILOPAY', {
      savePaymentMethodConsent: true,
      autopayMethod: 'SBP',
    });
    await namespace.createRenewalCheckout(
      { userId: 'user-1' },
      {
        subscriptionIds: ['sub-1'],
        gatewayType: 'ANTILOPAY',
        savePaymentMethodConsent: true,
        autopayMethod: 'SBP',
        autopayDelay: { count: 1, unit: 'QUARTER' },
      },
    );

    expect(calls[0]?.path).toBe('/api/internal/payments/checkout');
    expect(calls[0]?.body?.['autopayDelayCount']).toBe(7);
    expect(calls[0]?.body?.['autopayDelayUnit']).toBe('DAY');
    expect('autopayDelayCount' in (calls[1]?.body ?? {})).toBe(false);
    expect('autopayDelayUnit' in (calls[1]?.body ?? {})).toBe(false);
    expect(calls[2]?.path).toBe('/api/internal/payments/renewal-checkout');
    expect(calls[2]?.body?.['autopayDelayCount']).toBe(1);
    expect(calls[2]?.body?.['autopayDelayUnit']).toBe('QUARTER');
  });

  it('names the customer to the panel when it lists the gateways, and only then', async () => {
    await namespace.getEnabledGateways('WEB', 'user-1');
    await namespace.getEnabledGateways('WEB');
    await namespace.getEnabledGateways('TELEGRAM', '');
    await namespace.getEnabledGateways('WEB', 'a b&c');

    expect(calls.map((call) => call.path)).toEqual([
      '/api/internal/payments/gateways?channel=WEB&userId=user-1',
      '/api/internal/payments/gateways?channel=WEB',
      '/api/internal/payments/gateways?channel=TELEGRAM',
      '/api/internal/payments/gateways?channel=WEB&userId=a%20b%26c',
    ]);
  });
});
