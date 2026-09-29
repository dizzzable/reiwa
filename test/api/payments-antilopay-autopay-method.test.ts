import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPaymentsRouter } from '../../src/api/routes/payments.js';
import { PaymentsNamespace } from '../../src/infrastructure/admin-client/namespaces/payments.js';

/**
 * Antilopay repeats a charge on a card or over SBP — two kinds of recurrent
 * payment, chosen by the customer before the payment form opens. The choice
 * travels as `autopayMethod`, from the SPA through this route and the admin
 * client to the panel, and nothing else may take its place: a value that is not
 * one of the two is dropped here, so the panel answers a missing method
 * (`METHOD`) rather than being handed a guess.
 */

const createCheckout = vi.fn();
const createRenewalCheckout = vi.fn();

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
});

function post(path: string, body: unknown): Promise<{ status: number }> {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
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
  ...extra,
});

describe('POST /payments/checkout — the Antilopay method', () => {
  it.each(['CARD', 'SBP'])('forwards %s to the panel beside the consent', async (autopayMethod) => {
    createCheckout.mockResolvedValueOnce({ paymentId: 'p-1' });

    const response = await post('/api/v1/payments/checkout', checkoutBody({ autopayMethod }));

    expect(response.status).toBe(200);
    const options = createCheckout.mock.calls[0]?.[5] as Record<string, unknown>;
    expect(options['autopayMethod']).toBe(autopayMethod);
    expect(options['savePaymentMethodConsent']).toBe(true);
  });

  it.each([['PAYPAL'], [1], [null], [{ nested: 'CARD' }]])('drops %j', async (autopayMethod) => {
    createCheckout.mockResolvedValueOnce({ paymentId: 'p-1' });

    await post('/api/v1/payments/checkout', checkoutBody({ autopayMethod }));

    const options = createCheckout.mock.calls[0]?.[5] as Record<string, unknown>;
    expect('autopayMethod' in options).toBe(false);
  });

  it('sends nothing for a checkout that names no method', async () => {
    createCheckout.mockResolvedValueOnce({ paymentId: 'p-1' });

    await post('/api/v1/payments/checkout', checkoutBody({}));

    const options = createCheckout.mock.calls[0]?.[5] as Record<string, unknown>;
    expect('autopayMethod' in options).toBe(false);
  });
});

describe('POST /payments/renewal-checkout — the Antilopay method', () => {
  it('forwards a card or SBP, and drops anything else', async () => {
    createRenewalCheckout.mockResolvedValue({ paymentId: 'p-2' });
    const body = {
      subscriptionIds: ['sub-1'],
      gatewayType: 'ANTILOPAY',
      savePaymentMethodConsent: true,
    };

    await post('/api/v1/payments/renewal-checkout', { ...body, autopayMethod: 'SBP' });
    await post('/api/v1/payments/renewal-checkout', { ...body, autopayMethod: 'crypto' });

    expect((createRenewalCheckout.mock.calls[0]?.[1] as Record<string, unknown>)['autopayMethod']).toBe('SBP');
    expect('autopayMethod' in (createRenewalCheckout.mock.calls[1]?.[1] as Record<string, unknown>)).toBe(false);
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

  it('puts the method on the internal checkout and renewal-checkout bodies, and only a valid one', async () => {
    await namespace.createCheckout({ userId: 'user-1' }, 'NEW', 'plan-1', 30, 'ANTILOPAY', {
      savePaymentMethodConsent: true,
      autopayMethod: 'CARD',
    });
    await namespace.createCheckout({ userId: 'user-1' }, 'NEW', 'plan-1', 30, 'ANTILOPAY', {
      savePaymentMethodConsent: true,
      autopayMethod: 'BITCOIN' as never,
    });
    await namespace.createRenewalCheckout(
      { userId: 'user-1' },
      { subscriptionIds: ['sub-1'], gatewayType: 'ANTILOPAY', savePaymentMethodConsent: true, autopayMethod: 'SBP' },
    );

    expect(calls[0]?.path).toBe('/api/internal/payments/checkout');
    expect(calls[0]?.body?.['autopayMethod']).toBe('CARD');
    expect('autopayMethod' in (calls[1]?.body ?? {})).toBe(false);
    expect(calls[2]?.path).toBe('/api/internal/payments/renewal-checkout');
    expect(calls[2]?.body?.['autopayMethod']).toBe('SBP');
  });
});
