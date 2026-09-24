import express from 'express';
import http from 'node:http';
import { describe, expect, it } from 'vitest';

import { UpstreamError } from '../../../src/core/errors/index.js';
import { createPaymentMethodsRouter } from '../../../src/api/routes/payment-methods.js';

/**
 * PATCH and DELETE /api/v1/payment-methods/:methodId while a payment with the
 * method is being made.
 *
 * The panel refuses the customer's «Автосписание» switch and «Отвязать» at once
 * with 409 `SAVED_PAYMENT_METHOD_BUSY` instead of waiting for the charge past
 * its 30 s cut. This router used to answer every failure with a generic 400,
 * so «Способы оплаты» could only say the change failed. The code is forwarded
 * — and only that code: any other refusal keeps the generic answer.
 */

type PaymentMethodsFakes = {
  readonly setAutopay?: () => Promise<unknown>;
  readonly unbind?: () => Promise<unknown>;
};

function makeApp(paymentMethods: PaymentMethodsFakes) {
  const app = express();
  app.use(express.json());
  // The session guard is not under test: a WebSession reaches the handler.
  app.use((req, _res, next) => {
    (req as { webSession?: { userId: string } }).webSession = { userId: 'user_1' };
    next();
  });
  app.use(
    '/api/v1/payment-methods',
    createPaymentMethodsRouter({
      adminClient: { paymentMethods } as never,
      sessionStore: null,
      webSessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

async function call(
  app: express.Express,
  method: 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  } finally {
    server.close();
  }
}

/** The panel's body for the refusal, as its safe exception filter writes it. */
const PANEL_BUSY_BODY = JSON.stringify({
  statusCode: 409,
  message: 'A payment with this saved payment method is in progress; nothing was changed, try again in a minute',
  errorCode: 'SAVED_PAYMENT_METHOD_BUSY',
  code: 'SAVED_PAYMENT_METHOD_BUSY',
});

function busy(method: string, path: string): UpstreamError {
  return new UpstreamError(method, path, 409, PANEL_BUSY_BODY);
}

describe('the switch and «Отвязать» while a payment with the method is in progress', () => {
  it('answers the switch 409 with the code, so the page can say a payment is in progress', async () => {
    const app = makeApp({
      setAutopay: async () => {
        throw busy('PATCH', '/api/internal/user/user_1/payment-methods/pm-1');
      },
    });

    const res = await call(app, 'PATCH', '/api/v1/payment-methods/pm-1', { autopayEnabled: false });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'SAVED_PAYMENT_METHOD_BUSY' });
    // Nothing of the upstream body beyond the code reaches the browser.
    expect(res.body).not.toContain('/api/internal/');
  });

  it('answers «Отвязать» the same way', async () => {
    const app = makeApp({
      unbind: async () => {
        throw busy('DELETE', '/api/internal/user/user_1/payment-methods/pm-1');
      },
    });

    const res = await call(app, 'DELETE', '/api/v1/payment-methods/pm-1');

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'SAVED_PAYMENT_METHOD_BUSY' });
  });

  it('keeps the generic 400 for every other refusal', async () => {
    const app = makeApp({
      setAutopay: async () => {
        throw new UpstreamError('PATCH', '/api/internal/user/user_1/payment-methods/pm-1', 404, JSON.stringify({ code: 'SOMETHING_ELSE' }));
      },
    });

    const res = await call(app, 'PATCH', '/api/v1/payment-methods/pm-1', { autopayEnabled: false });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ message: 'Failed to update payment method autopay' });
  });
});
