import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { evaluateAccessMode } from '../../src/api/middleware/access-mode.js';
import { ADD_ON_PURCHASE_REFUSAL_CODES } from '../../src/api/routes/add-on-purchase-errors.js';
import { createContentRouter } from '../../src/api/routes/content.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';

/**
 * `POST /add-ons/purchase` answered every refusal of the panel with a bare 400
 * «Add-on purchase failed», so the purchase page could only say «Не удалось
 * создать платёж. Попробуйте позже.» — for an add-on withdrawn while the page
 * was open, a lapsed subscription, a payment method switched off. It now
 * forwards the refusals it recognises as a code and a fixed sentence, and
 * nothing else the panel said.
 *
 * The bodies below are what the panel's `AdminSafeExceptionFilter` writes for
 * each throw of `addon-purchase.service.ts` (rezeis-admin 0.9.7.70, plus the
 * pair patch's second lifetime sentence). Three codes survive that filter
 * (`PURCHASES_DISABLED`, `SERVICE_RESTRICTED`, `IDEMPOTENCY_KEY_CONFLICT`); the
 * add-on's own codes are stripped to the sentence and a status-derived
 * `errorCode`, and the rest were never codes at all.
 *
 * Driven through the real router: the status the route finally sends lives in
 * its catch block, where a helper-level test cannot see it.
 */

const PANEL_PATH = '/api/internal/add-ons/purchase';
const GENERIC = { message: 'Add-on purchase failed' };

const STATUS_NAME: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'INTERNAL_SERVER_ERROR',
};

/**
 * A refusal as the filter serialises it. `code` only when the filter
 * allowlists it (then `errorCode` is the same value); `error` only for a throw
 * made from a bare string, which is what gives Nest's response that field.
 */
function panelBody(
  status: number,
  message: unknown,
  options: { readonly code?: string; readonly error?: string } = {},
): string {
  return JSON.stringify({
    timestamp: '2026-09-26T12:00:00.000Z',
    path: PANEL_PATH,
    requestId: 'req-addon-1',
    statusCode: status,
    message,
    errorCode: options.code ?? STATUS_NAME[status] ?? `HTTP_${status}`,
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
  });
}

interface RefusalCase {
  readonly name: string;
  readonly status: number;
  readonly body: string;
  readonly panelWords: string;
  readonly answer: { readonly status: number; readonly code: string };
}

const LIFETIME_SENTENCE = 'This add-on cannot be delivered for its advertised period on this subscription';
const AUDIENCE_SENTENCE =
  'This add-on ends at the next traffic reset, which the calling cabinet cannot show; update Reiwa';
const REVISION_SENTENCE = 'Add-on changed since it was shown; refresh and try again';
const PROVIDER_SENTENCE = 'Payment provider outcome is unknown; awaiting reconciliation';

/** Every refusal the released panel (and the pair patch) can put on the wire for this checkout. */
const REFUSALS: readonly RefusalCase[] = [
  {
    name: 'lifetime cannot be delivered (code stripped by the filter)',
    status: 400,
    body: panelBody(400, LIFETIME_SENTENCE),
    panelWords: LIFETIME_SENTENCE,
    answer: { status: 400, code: 'ADDON_LIFETIME_UNAVAILABLE' },
  },
  {
    name: 'a «до сброса» add-on for a cabinet that cannot show its end (pair patch)',
    status: 400,
    body: panelBody(400, AUDIENCE_SENTENCE),
    panelWords: AUDIENCE_SENTENCE,
    answer: { status: 400, code: 'ADDON_LIFETIME_UNAVAILABLE' },
  },
  {
    name: 'add-on switched off or deleted',
    status: 404,
    body: panelBody(404, 'Add-on not found', { error: 'Not Found' }),
    panelWords: 'Add-on not found',
    answer: { status: 400, code: 'ADDON_NOT_AVAILABLE' },
  },
  {
    name: 'add-on not for this plan',
    status: 400,
    body: panelBody(400, 'Add-on is not available for this subscription plan', { error: 'Bad Request' }),
    panelWords: 'Add-on is not available for this subscription plan',
    answer: { status: 400, code: 'ADDON_NOT_AVAILABLE' },
  },
  {
    name: 'traffic already unlimited',
    status: 400,
    body: panelBody(400, 'Subscription has unlimited traffic — extra traffic cannot be applied', {
      error: 'Bad Request',
    }),
    panelWords: 'Subscription has unlimited traffic',
    answer: { status: 400, code: 'ADDON_ALREADY_UNLIMITED' },
  },
  {
    name: 'devices already unlimited',
    status: 400,
    body: panelBody(400, 'Subscription has unlimited devices — extra devices cannot be applied', {
      error: 'Bad Request',
    }),
    panelWords: 'Subscription has unlimited devices',
    answer: { status: 400, code: 'ADDON_ALREADY_UNLIMITED' },
  },
  {
    name: 'subscription not active',
    status: 400,
    body: panelBody(400, 'Add-ons require an active subscription', { error: 'Bad Request' }),
    panelWords: 'Add-ons require an active subscription',
    answer: { status: 400, code: 'ADDON_SUBSCRIPTION_NOT_ACTIVE' },
  },
  {
    name: 'no price in the method’s currency',
    status: 400,
    body: panelBody(400, 'Add-on has no price for the selected payment method', { error: 'Bad Request' }),
    panelWords: 'Add-on has no price for the selected payment method',
    answer: { status: 400, code: 'ADDON_NO_PRICE_FOR_GATEWAY' },
  },
  {
    name: 'add-on changed since it was shown (code stripped)',
    status: 409,
    body: panelBody(409, REVISION_SENTENCE),
    panelWords: REVISION_SENTENCE,
    answer: { status: 409, code: 'ADDON_REVISION_CONFLICT' },
  },
  {
    name: 'retry key used for another composition (code allowlisted)',
    status: 409,
    body: panelBody(409, 'Idempotency key was already used for a different checkout', {
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    }),
    panelWords: 'Idempotency key was already used',
    answer: { status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' },
  },
  {
    name: 'payment provider did not answer (code stripped)',
    status: 503,
    body: panelBody(503, PROVIDER_SENTENCE),
    panelWords: PROVIDER_SENTENCE,
    answer: { status: 502, code: 'PROVIDER_OUTCOME_UNKNOWN' },
  },
  ...(
    [
      'PAYMENT_GATEWAY_NOT_ACTIVE',
      'PAYMENT_GATEWAY_NOT_CONFIGURED',
      'PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED',
      'PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED',
    ] as const
  ).map(
    (code): RefusalCase => ({
      name: `${code} (the code is the whole message)`,
      status: 400,
      body: panelBody(400, code, { error: 'Bad Request' }),
      panelWords: 'Bad Request',
      answer: { status: 400, code },
    }),
  ),
  {
    name: 'the panel’s own access-mode gate: purchases blocked',
    status: 403,
    body: panelBody(403, 'New purchases are temporarily unavailable', { code: 'PURCHASES_DISABLED' }),
    panelWords: 'req-addon-1',
    answer: { status: 403, code: 'PURCHASES_DISABLED' },
  },
  {
    name: 'the panel’s own access-mode gate: restricted',
    status: 503,
    body: panelBody(503, 'Service is temporarily unavailable', { code: 'SERVICE_RESTRICTED' }),
    panelWords: 'req-addon-1',
    answer: { status: 503, code: 'SERVICE_RESTRICTED' },
  },
];

const purchase = vi.fn();
const silentLogger = {
  info: () => undefined,
  warn: vi.fn(),
  error: vi.fn(),
  debug: () => undefined,
  child: () => silentLogger,
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // `requireMode` reads the admin client off app.locals and fails open when the
  // policy cache is unavailable — the edge gate is not what this file is about.
  app.locals['adminClient'] = null;
  app.use((req, _res, next) => {
    req.webSession = { userId: 'user-cuid-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    (req as unknown as { log: typeof silentLogger }).log = silentLogger;
    next();
  });
  app.use(
    '/api/v1',
    createContentRouter({
      adminClient: { addOns: { purchase } } as never,
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
  purchase.mockReset();
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

async function postPurchase(): Promise<{ status: number; body: unknown; raw: string }> {
  const raw = JSON.stringify({
    addOnId: 'addon-1',
    subscriptionId: 'sub-1',
    gatewayType: 'YOOKASSA',
    expectedAddOnRevision: 3,
    idempotencyKey: 'key-1',
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/add-ons/purchase',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data.length > 0 ? JSON.parse(data) : null, raw: data });
        });
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

function refuse(status: number, body: string): void {
  purchase.mockRejectedValueOnce(new UpstreamError('POST', PANEL_PATH, status, body));
}

describe('POST /add-ons/purchase — refusals the panel names', () => {
  it.each(REFUSALS)('$name → $answer.status $answer.code', async (refusal) => {
    refuse(refusal.status, refusal.body);

    const response = await postPurchase();

    expect(response.status).toBe(refusal.answer.status);
    // Exact: the code and a fixed sentence, and nothing the panel sent beside
    // them — no errorCode, no path, no request id, no sentence of its own.
    expect(Object.keys(response.body as object).sort()).toEqual(['code', 'message']);
    expect((response.body as { code: string }).code).toBe(refusal.answer.code);
    expect(response.raw).not.toContain(refusal.panelWords);
    expect(response.raw).not.toContain(PANEL_PATH);
    // Still in the server log, by its code.
    expect(silentLogger.warn).toHaveBeenCalledWith(
      { code: refusal.answer.code, upstreamStatus: refusal.status },
      'add-ons/purchase refused',
    );
  });

  it('covers every code the route forwards', () => {
    // A code added to the allowlist without a wire shape here is a code whose
    // recognition nothing proves.
    expect(new Set(REFUSALS.map((refusal) => refusal.answer.code))).toEqual(new Set(ADD_ON_PURCHASE_REFUSAL_CODES));
  });

  it('answers the two access-mode codes exactly as this route’s own gate does', async () => {
    for (const [mode, code] of [
      ['PURCHASE_BLOCKED', 'PURCHASES_DISABLED'],
      ['RESTRICTED', 'SERVICE_RESTRICTED'],
    ] as const) {
      const gate = evaluateAccessMode({ gate: 'purchase.addon', mode });
      expect(gate?.code).toBe(code);
      refuse(gate!.status, panelBody(gate!.status, gate!.message, { code }));

      const response = await postPurchase();

      expect(response.status, code).toBe(gate!.status);
      expect(response.body).toEqual({ code, message: gate!.message });
    }
  });

  it('reads a panel that allowlists the add-on codes, top level or nested', async () => {
    // Rezeis Admin 0.9.7.71 adds its add-on codes to `SAFE_PRODUCT_CODES`, so
    // the code arrives beside the sentence; the reading must not depend on the
    // sentence then.
    refuse(400, panelBody(400, 'reworded', { code: 'ADDON_LIFETIME_UNAVAILABLE' }));
    expect(await postPurchase()).toMatchObject({ status: 400, body: { code: 'ADDON_LIFETIME_UNAVAILABLE' } });

    refuse(503, panelBody(503, 'reworded', { code: 'PROVIDER_OUTCOME_UNKNOWN' }));
    expect(await postPurchase()).toMatchObject({ status: 502, body: { code: 'PROVIDER_OUTCOME_UNKNOWN' } });

    refuse(409, JSON.stringify({ statusCode: 409, message: { code: 'ADDON_REVISION_CONFLICT', message: 'x' } }));
    expect(await postPurchase()).toMatchObject({ status: 409, body: { code: 'ADDON_REVISION_CONFLICT' } });
  });
});

/**
 * The bodies below are the panel filter's own output, not a reconstruction:
 * `$SW/pair/a1-work/filter-body.cjs` runs `AdminSafeExceptionFilter` from
 * released main over each throw — as released (0.9.7.70) and with the four
 * codes F1 adds to `SAFE_PRODUCT_CODES` (0.9.7.71). Only `timestamp` and
 * `requestId` are this file's.
 */
function realBody(fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-09-26T12:00:00.000Z',
    path: PANEL_PATH,
    requestId: 'req-a1-1',
    ...fields,
  });
}

describe('POST /add-ons/purchase — the code when one came, the sentence only when none did', () => {
  it.each([
    [
      'ADDON_LIFETIME_UNAVAILABLE',
      400,
      400,
      { statusCode: 400, message: LIFETIME_SENTENCE, errorCode: 'ADDON_LIFETIME_UNAVAILABLE', code: 'ADDON_LIFETIME_UNAVAILABLE' },
      { statusCode: 400, message: LIFETIME_SENTENCE, errorCode: 'BAD_REQUEST' },
    ],
    [
      'ADDON_REVISION_CONFLICT',
      409,
      409,
      { statusCode: 409, message: REVISION_SENTENCE, errorCode: 'ADDON_REVISION_CONFLICT', code: 'ADDON_REVISION_CONFLICT' },
      { statusCode: 409, message: REVISION_SENTENCE, errorCode: 'CONFLICT' },
    ],
    [
      'PROVIDER_OUTCOME_UNKNOWN',
      503,
      502,
      { statusCode: 503, message: PROVIDER_SENTENCE, errorCode: 'PROVIDER_OUTCOME_UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' },
      { statusCode: 503, message: PROVIDER_SENTENCE, errorCode: 'INTERNAL_SERVER_ERROR' },
    ],
  ] as const)('%s: forwarded by its code from 0.9.7.71, by status and sentence from 0.9.7.70', async (code, panelStatus, ours, withCode, stripped) => {
    refuse(panelStatus, realBody(withCode));
    expect(await postPurchase()).toMatchObject({ status: ours, body: { code } });

    refuse(panelStatus, realBody(stripped));
    expect(await postPurchase()).toMatchObject({ status: ours, body: { code } });
  });

  it('a code wins over a sentence that names another refusal', async () => {
    // Both readings are possible at 400: the code says the lifetime, the
    // sentence says the subscription. The code is what the panel meant.
    refuse(
      400,
      realBody({
        statusCode: 400,
        message: 'Add-ons require an active subscription',
        errorCode: 'ADDON_LIFETIME_UNAVAILABLE',
        code: 'ADDON_LIFETIME_UNAVAILABLE',
      }),
    );

    expect(await postPurchase()).toMatchObject({ status: 400, body: { code: 'ADDON_LIFETIME_UNAVAILABLE' } });
  });

  it('a code decides whatever status it came with', async () => {
    // The status is part of the sentence reading only: a panel that moves a
    // refusal to another status still names it.
    refuse(400, realBody({ statusCode: 400, message: 'x', errorCode: 'ADDON_REVISION_CONFLICT', code: 'ADDON_REVISION_CONFLICT' }));

    expect(await postPurchase()).toMatchObject({ status: 409, body: { code: 'ADDON_REVISION_CONFLICT' } });
  });

  it('a blocked account from 0.9.7.71 (code forwarded) keeps the generic answer here, sentence unread', async () => {
    refuse(
      403,
      realBody({ statusCode: 403, message: 'This account is blocked', errorCode: 'USER_BLOCKED', code: 'USER_BLOCKED' }),
    );

    expect(await postPurchase()).toMatchObject({ status: 400, body: GENERIC });
  });
});

describe('POST /add-ons/purchase — what keeps the generic answer', () => {
  it.each([
    ['a code the cabinet does not know', 400, panelBody(400, 'Something new', { code: 'SOMETHING_NEW' })],
    [
      'a provider’s own text',
      400,
      panelBody(400, 'Antilopay error 7: card 2200 1234 declined for buyer@example.com', { error: 'Bad Request' }),
    ],
    ['a blocked account (its code stripped by the filter)', 403, panelBody(403, 'This account is blocked')],
    ['a subscription that is not the caller’s', 404, panelBody(404, 'Subscription not found', { error: 'Not Found' })],
    ['a user the panel does not know', 404, panelBody(404, 'User not found', { error: 'Not Found' })],
    [
      'the zero-price race',
      409,
      panelBody(409, 'Zero-value add-on checkout is already being fulfilled', { error: 'Conflict' }),
    ],
    [
      'a validation refusal',
      400,
      panelBody(400, ['gatewayType must be one of the following values: YOOKASSA'], { error: 'Bad Request' }),
    ],
    ['the panel’s token check', 401, panelBody(401, 'Request failed', { error: 'Unauthorized' })],
    ['an unexpected fault', 500, panelBody(500, 'Internal server error', { error: 'Internal Server Error' })],
  ])('%s', async (_name, status, body) => {
    refuse(status, body);

    const response = await postPurchase();

    expect(response.status).toBe(400);
    expect(response.body).toEqual(GENERIC);
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a known sentence at another status', 409, panelBody(409, 'Add-ons require an active subscription')],
    ['the provider sentence at 400', 400, panelBody(400, PROVIDER_SENTENCE)],
    [
      'a known sentence beside a code the cabinet does not forward',
      400,
      panelBody(400, 'Add-ons require an active subscription', { code: 'USER_BLOCKED' }),
    ],
    ['a sentence reworded by one character', 400, panelBody(400, 'Add-ons require an active subscription.')],
    ['a gateway code in another case', 400, panelBody(400, 'payment_gateway_not_active')],
    ['a status name as errorCode and nothing else', 400, JSON.stringify({ errorCode: 'BAD_REQUEST' })],
  ])('%s', async (_name, status, body) => {
    refuse(status, body);

    expect(await postPurchase()).toMatchObject({ status: 400, body: GENERIC });
  });

  it.each([
    ['a proxy’s HTML page', 502, '<html><body>502 Bad Gateway</body></html>'],
    ['a JSON array', 400, JSON.stringify(['ADDON_LIFETIME_UNAVAILABLE'])],
    ['an empty body', 400, ''],
  ])('%s', async (_name, status, body) => {
    refuse(status, body);

    expect(await postPurchase()).toMatchObject({ status: 400, body: GENERIC });
  });

  it('a failure that is not the panel’s answer at all', async () => {
    purchase.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:4000 ADDON_LIFETIME_UNAVAILABLE'));

    expect(await postPurchase()).toMatchObject({ status: 400, body: GENERIC });
  });
});
