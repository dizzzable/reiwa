import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPaymentsRouter } from '../../src/api/routes/payments.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';

/**
 * «для автоматического списания» refused with its reason, through the real
 * checkout route.
 *
 * One code, many reasons, and one of them asks the buyer for the opposite of
 * the rest: `PENDING_SIGN_UP` — another sign-up converting the same trial still
 * waits for the bank, and the ordinary payment the page offers for the others
 * would convert the trial twice. The panel's exception filter lets an
 * allowlisted reason through; this route dropped it, answering `{ code,
 * message }`. It now adds the reason, the same allowlist, and nothing else from
 * the body.
 */

/** The body the panel's AdminSafeExceptionFilter writes for this refusal. */
function panelBody(reason: unknown): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    path: '/api/internal/payments/checkout',
    requestId: 'req-autopay',
    statusCode: 400,
    message: 'Automatic charging is not available for this purchase.',
    errorCode: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
    code: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
    ...(reason === undefined ? {} : { reason }),
    error: 'Bad Request',
  });
}

const createCheckout = vi.fn();

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.locals['adminClient'] = null;
  app.use((req, _res, next) => {
    req.webSession = { userId: 'user-cuid-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    next();
  });
  app.use(
    '/api/v1',
    createPaymentsRouter({
      adminClient: { payments: { createCheckout } } as never,
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
  vi.restoreAllMocks();
  createCheckout.mockReset();
});

async function postCheckout(): Promise<{ status: number; body: unknown }> {
  const raw = JSON.stringify({
    planId: 'plan-p',
    durationDays: 30,
    gatewayType: 'PLATEGA',
    purchaseType: 'UPGRADE',
    subscriptionId: 'trial-1',
    savePaymentMethodConsent: true,
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/payments/checkout',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data.length > 0 ? JSON.parse(data) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

function refuse(reason: unknown): void {
  createCheckout.mockRejectedValueOnce(
    new UpstreamError('POST', '/api/internal/payments/checkout', 400, panelBody(reason)),
  );
}

describe('POST /payments/checkout — an autopay refusal and its reason', () => {
  it('forwards a sign-up already under way beside the code, and nothing else', async () => {
    refuse('PENDING_SIGN_UP');

    const response = await postCheckout();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      message: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      reason: 'PENDING_SIGN_UP',
    });
  });

  it('forwards the other allowlisted reasons the same way', async () => {
    refuse('PLAN_CHANGE');

    expect((await postCheckout()).body).toEqual({
      code: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      message: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      reason: 'PLAN_CHANGE',
    });
  });

  it.each([
    ['no reason (an older panel)', undefined],
    ['a reason outside the allowlist', 'req-autopay /api/internal/payments/checkout'],
    ['a reason that is not a string', { nested: 'PENDING_SIGN_UP' }],
  ])('answers the code alone for %s', async (_case, reason) => {
    refuse(reason);

    expect((await postCheckout()).body).toEqual({
      code: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
      message: 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE',
    });
  });
});
