import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ADD_ON_PURCHASE_REFUSAL_CODES as PAGE_CODES,
  GENERIC_ADD_ON_PURCHASE_FAILURE,
  answerAddOnPurchaseFailure,
  readAddOnPurchaseRefusal,
} from '@/features/addons/purchase-refusal';
import { purchaseAddOn } from '@/lib/api-client/content';
import { apiClient } from '@/lib/api-client/transport';

import { ADD_ON_PURCHASE_REFUSAL_CODES as ROUTE_CODES } from '../../src/api/routes/add-on-purchase-errors.js';
import { createContentRouter } from '../../src/api/routes/content.js';
import { loadConfig } from '../../src/core/config/index.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
// The backend's `Express.Request` augmentation (`webSession`, `context`), as in
// `partner-withdraw-refusal-contract.test.ts` next door.
import '../../src/infrastructure/redis/types.js';

/**
 * An add-on purchase refused by the panel — from the body the panel's error
 * filter writes to the reader the purchase page calls, through the REAL admin
 * transport, the REAL content router and the page's own axios client.
 *
 * The route test (`test/api/add-on-purchase-refusal-route.test.ts`) pins every
 * wire shape against a stubbed client; this one proves the pieces meet: the
 * transport hands the route the status and body it reads, the page's client
 * surfaces what the route sends, and the page's list of codes is the route's.
 */

const PANEL_PATH = '/api/internal/add-ons/purchase';
const PURCHASE = { addOnId: 'addon-1', subscriptionId: 'sub-1', gatewayType: 'YOOKASSA', expectedAddOnRevision: 3 };

let panelReply: { status: number; body: Record<string, unknown> };
let panelCalls: string[];
let panel: http.Server;
let cabinet: http.Server;
let adminClient: AdminClient;

/** A refusal as the panel's `AdminSafeExceptionFilter` serialises it. */
function panelRefusal(
  status: number,
  message: string,
  code?: string,
): { status: number; body: Record<string, unknown> } {
  const errorCode = code ?? ({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' } as Record<number, string>)[status] ?? 'INTERNAL_SERVER_ERROR';
  return {
    status,
    body: {
      timestamp: new Date().toISOString(),
      path: PANEL_PATH,
      requestId: null,
      statusCode: status,
      message,
      errorCode,
      ...(code !== undefined ? { code } : {}),
    },
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  panel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      panelCalls.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.statusCode = panelReply.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(panelReply.body));
    });
  });
  adminClient = new AdminClient(await listen(panel), 'internal-token');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = { userId: 'user-cuid-1', createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
    (req as unknown as { log: unknown }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child() {
        return this;
      },
    };
    next();
  });
  app.use('/api/v1', createContentRouter({ adminClient, sessionStore: null, config: loadConfig({ NODE_ENV: 'test' }) }));
  cabinet = http.createServer(app);
  apiClient.defaults.baseURL = `${await listen(cabinet)}/api/v1`;
});

beforeEach(() => {
  panelCalls = [];
});

afterAll(async () => {
  apiClient.defaults.baseURL = '/api/v1';
  await adminClient.close();
  await Promise.all([panel, cabinet].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function refusedInTheBrowser(): Promise<{ status: unknown; data: unknown; error: unknown }> {
  try {
    await purchaseAddOn({ ...PURCHASE, idempotencyKey: 'key-1' });
  } catch (error: unknown) {
    const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
    return { status: response?.status, data: response?.data, error };
  }
  throw new Error('expected the purchase to be refused');
}

describe('the page and the route forward the same codes', () => {
  it('in the same order', () => {
    expect([...PAGE_CODES]).toEqual([...ROUTE_CODES]);
  });
});

describe('the real admin transport', () => {
  it('hands the route the panel’s status and body, and asks once — even at 503', async () => {
    // 503 is the provider refusal, and `UpstreamError.isRetryable` says yes to
    // it; a retried checkout would be a second draft. The transport does not.
    panelReply = panelRefusal(503, 'Payment provider outcome is unknown; awaiting reconciliation');

    let failure: unknown;
    try {
      await adminClient.addOns.purchase({ identity: { userId: 'user-cuid-1' }, ...PURCHASE });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).status).toBe(503);
    expect(JSON.parse((failure as UpstreamError).body)).toMatchObject({ statusCode: 503, errorCode: 'INTERNAL_SERVER_ERROR' });
    expect(panelCalls).toEqual([`POST ${PANEL_PATH}`]);
  });
});

describe('a refusal reaches the purchase page as its code', () => {
  // One of each wire shape: a stripped code (by its sentence), the same code
  // forwarded (Rezeis Admin 0.9.7.71), a sentence that never had a code, a
  // stripped 409, the provider's 503 (answered 502), a code that is the whole
  // message, and a code the filter always let through.
  it.each([
    ['ADDON_LIFETIME_UNAVAILABLE', 400, panelRefusal(400, 'This add-on cannot be delivered for its advertised period on this subscription')],
    [
      'ADDON_LIFETIME_UNAVAILABLE',
      400,
      panelRefusal(400, 'This add-on cannot be delivered for its advertised period on this subscription', 'ADDON_LIFETIME_UNAVAILABLE'),
    ],
    ['ADDON_SUBSCRIPTION_NOT_ACTIVE', 400, panelRefusal(400, 'Add-ons require an active subscription')],
    ['ADDON_REVISION_CONFLICT', 409, panelRefusal(409, 'Add-on changed since it was shown; refresh and try again')],
    ['PROVIDER_OUTCOME_UNKNOWN', 502, panelRefusal(503, 'Payment provider outcome is unknown; awaiting reconciliation')],
    ['PAYMENT_GATEWAY_NOT_ACTIVE', 400, panelRefusal(400, 'PAYMENT_GATEWAY_NOT_ACTIVE')],
    ['PURCHASES_DISABLED', 403, panelRefusal(403, 'New purchases are temporarily unavailable', 'PURCHASES_DISABLED')],
  ] as const)('%s → %i, and the page reads it', async (code, status, reply) => {
    panelReply = reply;

    const answer = await refusedInTheBrowser();

    expect(answer.status).toBe(status);
    expect(Object.keys(answer.data as object).sort()).toEqual(['code', 'message']);
    expect((answer.data as { code?: unknown }).code).toBe(code);
    // The panel's own sentence stays behind — except where the code IS the
    // sentence, or the sentence is the one this route's own gate says.
    const panelWords = String(reply.body['message']);
    if (panelWords !== code && code !== 'PURCHASES_DISABLED') {
      expect(JSON.stringify(answer.data)).not.toContain(panelWords);
    }
    expect(readAddOnPurchaseRefusal(answer.error)).toBe(code);
    expect(answerAddOnPurchaseFailure(answer.error)).not.toEqual(GENERIC_ADD_ON_PURCHASE_FAILURE);
  });

  it('anything else keeps the generic answer, on the route and on the page', async () => {
    panelReply = panelRefusal(400, 'Something the cabinet has never heard of', 'SOMETHING_NEW');

    const answer = await refusedInTheBrowser();

    expect(answer).toMatchObject({ status: 400, data: { message: 'Add-on purchase failed' } });
    expect(readAddOnPurchaseRefusal(answer.error)).toBeNull();
    expect(answerAddOnPurchaseFailure(answer.error)).toEqual(GENERIC_ADD_ON_PURCHASE_FAILURE);
  });
});
