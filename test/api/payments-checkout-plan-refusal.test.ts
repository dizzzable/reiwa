import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPaymentsRouter } from '../../src/api/routes/payments.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';

/**
 * A plan the panel no longer sells must reach the cabinet as a refusal it can
 * name, not as a server fault.
 *
 * The panel refuses such a checkout BEFORE any charge: its quote marks the plan
 * `PLAN_NOT_AVAILABLE`, and the draft step answers 400
 * `PAYMENT_DRAFT_PLAN_NOT_AVAILABLE` (a panel that predates that code answers
 * `PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE`, which is also its answer to every other
 * ineligible quote) — codes its safe exception filter allowlists precisely so
 * a client can branch on them. This route collapsed them into `500 Failed to
 * create checkout`, so the purchase page could only show a generic toast over
 * a spinner that never stopped. A subscriber still looking at an earlier
 * catalogue meets exactly this when an operator archives or deletes a plan.
 *
 * Driven through the real router, because the mapping lives in the catch block
 * and a helper-level test cannot see which status the route finally sends.
 */

/** The body the panel's AdminSafeExceptionFilter writes for this refusal. */
const QUOTE_NOT_ELIGIBLE_BODY = JSON.stringify({
  timestamp: new Date().toISOString(),
  path: '/api/internal/payments/checkout',
  requestId: 'req-plan-gone',
  statusCode: 400,
  message: 'Quote is not eligible for transaction draft creation.',
  errorCode: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
  code: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
  error: 'Bad Request',
  // Not sent by today's filter. Present so the assertion below proves the
  // route forwards a code and a fixed message, never what the panel adds.
  warnings: [{ code: 'PLAN_NOT_AVAILABLE', message: 'The selected plan is not available for this action.' }],
});

const createCheckout = vi.fn();

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // `requireMode` reads the admin client off app.locals and fails open when the
  // policy cache is unavailable — the gate is not what this file is about.
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

/** One listening server for the whole file: a server per request churns ports. */
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
    planId: 'plan-archived',
    durationDays: 30,
    gatewayType: 'YOOKASSA',
    purchaseType: 'NEW',
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

describe('POST /payments/checkout — a plan that is no longer for sale', () => {
  it('forwards the panel code for a withdrawn plan as a typed 400', async () => {
    // Since the panel names a withdrawn plan apart from other ineligible quotes,
    // this is the code the purchase page answers by refetching the plan list.
    // Dropped here, it would reach the cabinet as a 500 and that answer is lost.
    createCheckout.mockRejectedValueOnce(
      new UpstreamError(
        'POST',
        '/api/internal/payments/checkout',
        400,
        JSON.stringify({
          statusCode: 400,
          message: 'The selected plan or duration is no longer available.',
          errorCode: 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE',
          code: 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE',
        }),
      ),
    );

    const response = await postCheckout();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE',
      message: 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE',
    });
  });

  it('answers with a typed 400 carrying the panel code, not a 500', async () => {
    createCheckout.mockRejectedValueOnce(
      new UpstreamError('POST', '/api/internal/payments/checkout', 400, QUOTE_NOT_ELIGIBLE_BODY),
    );

    const response = await postCheckout();

    expect(response.status).toBe(400);
    // Exact equality: a code and a message, and nothing the panel sent beside
    // them — no warnings, no internal path, no request id.
    expect(response.body).toEqual({
      code: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
      message: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
    });
  });

  it('still answers an unrecognised 400 with the generic 500 and no upstream text', async () => {
    // Guards the shape of the fix: an allowlist entry, not "forward every 400".
    // Panel text that is not a vetted product code must stay server-side.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createCheckout.mockRejectedValueOnce(
      new UpstreamError(
        'POST',
        '/api/internal/payments/checkout',
        400,
        JSON.stringify({ statusCode: 400, message: 'PAYMENT_GATEWAY_NOT_ACTIVE', errorCode: 'BAD_REQUEST' }),
      ),
    );

    const response = await postCheckout();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Failed to create checkout' });
  });
});
