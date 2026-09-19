import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWithdrawal,
  readWithdrawalAnswer,
  readWithdrawalRefusal,
} from '@/lib/api-client/partner';
import { apiClient } from '@/lib/api-client/transport';

import { UpstreamError } from '../../src/core/errors/upstream-error.js';
import { createPartnerRouter } from '../../src/api/routes/partner.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
// The backend's `Express.Request` augmentation (`webSession`, `context`), as in
// `partner-balance-hold-contract.test.ts` next door.
import '../../src/infrastructure/redis/types.js';

/**
 * A withdrawal refused by the panel — from the panel's error filter to the
 * reader the withdrawal dialog calls, through the REAL admin transport, the
 * REAL partner router and the page's own axios client.
 *
 * The panel names each refusal with a code now (rezeis-admin
 * `partners/utils/partner-withdrawal-rules.ts`) and answers with a status that
 * says what kind it is: 409 for the program's or the partner's state, 422 for an
 * amount it cannot take. Not 401/403: this cabinet's admin client classifies
 * those as "the panel rejected our token" (`UpstreamError.isAuthFailure`). The
 * first describe proves the transport's own reading of 409 and 422 — a refusal,
 * not a credentials problem, and not retried.
 *
 * The stand-in panel answers with the bodies the panel's filter writes, key for
 * key (`rezeis-admin/test/partner-withdrawal-refusals.spec.ts` pins them).
 */

const USER_ID = 'user-cuid-1';
const WITHDRAW_PATH = `/api/internal/user/${USER_ID}/partner/withdraw`;
const MINIMUM = 30_700;
const WITHDRAWAL = { amount: 20_000, method: 'card', requisites: '2200 1234 5678 9012' };

let panelReply: { status: number; body: Record<string, unknown> };
let panelCalls: string[];
let panel: http.Server;
let cabinet: http.Server;
let adminClient: AdminClient;

const STATUS_TEXT: Readonly<Record<number, string | undefined>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  409: 'Conflict',
  422: 'Unprocessable Entity',
};

/** The panel's refusal as its `AdminSafeExceptionFilter` serialises it. */
function panelRefusal(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): { status: number; body: Record<string, unknown> } {
  const error = STATUS_TEXT[status];
  return {
    status,
    body: {
      timestamp: new Date().toISOString(),
      path: '/api/internal/user/:redacted/partner/withdraw',
      requestId: null,
      statusCode: status,
      message,
      errorCode: code,
      code,
      ...extra,
      ...(error === undefined ? {} : { error }),
    },
  };
}

const REFUSALS = [
  { status: 409, code: 'PARTNER_NOT_FOUND', panelMessage: 'Partner not found', forwarded: 'Partner not found' },
  {
    status: 409,
    code: 'PARTNER_PROGRAM_INVITED_ONLY',
    panelMessage: 'The partner program is open to invited users only',
    forwarded: 'The partner program is open to invited users only',
  },
  { status: 409, code: 'PARTNER_NOT_ACTIVE', panelMessage: 'Partner is not active', forwarded: 'Partner is not active' },
  {
    status: 422,
    code: 'WITHDRAWAL_INSUFFICIENT_BALANCE',
    panelMessage: 'Insufficient partner balance',
    forwarded: 'Insufficient partner balance',
  },
] as const;

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  panel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // The fresh session check the route asks first: never signed out.
      if ((req.url ?? '').startsWith('/api/internal/web-auth/sessions/state')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessionsRevokedAt: null, now: new Date().toISOString() }));
        return;
      }
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
    req.webSession = { userId: USER_ID, createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
    next();
  });
  app.use('/api/v1', createPartnerRouter({ adminClient, sessionStore: null, config: loadConfig({ NODE_ENV: 'test' }) }));
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

async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the call to be refused');
}

/** The browser's view of a refused `/partner/withdraw`. */
async function refusedInTheBrowser(): Promise<{ status: unknown; data: unknown; error: unknown }> {
  const error = await failureOf(() => createWithdrawal(WITHDRAWAL));
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
  return { status: response?.status, data: response?.data, error };
}

describe('the real admin transport reads 409 and 422 as refusals', () => {
  it.each([...REFUSALS.map((refusal) => [refusal.status, refusal.code] as const), [422, 'WITHDRAWAL_BELOW_MINIMUM'] as const])(
    '%i %s: a typed refusal, not a rejected token, and asked once',
    async (status, code) => {
      panelReply = panelRefusal(status, code, 'x');

      const error = await failureOf(() => adminClient.partner.createWithdrawal({ userId: USER_ID }, WITHDRAWAL));

      expect(error).toBeInstanceOf(UpstreamError);
      const upstream = error as UpstreamError;
      expect(upstream.status).toBe(status);
      expect(upstream.isAuthFailure, 'read as the panel rejecting the cabinet’s token').toBe(false);
      expect(upstream.isRetryable).toBe(false);
      expect(panelCalls).toEqual([`POST ${WITHDRAW_PATH}`]);
    },
  );

  it('CONTROL: the same transport does read a 403 as a rejected token — why the panel must not use it', async () => {
    panelReply = panelRefusal(403, 'PARTNER_PROGRAM_INVITED_ONLY', 'x');

    const error = await failureOf(() => adminClient.partner.createWithdrawal({ userId: USER_ID }, WITHDRAWAL));

    expect((error as UpstreamError).isAuthFailure).toBe(true);
  });
});

describe('each coded refusal reaches the withdrawal dialog', () => {
  it.each(REFUSALS)('$code: its status, its code and a fixed message — never the panel’s sentence', async (refusal) => {
    panelReply = panelRefusal(refusal.status, refusal.code, `${refusal.panelMessage} (panel wording)`);

    const answer = await refusedInTheBrowser();

    expect(answer.status).toBe(refusal.status);
    expect(answer.data).toEqual({ code: refusal.code, message: refusal.forwarded });
    expect(readWithdrawalRefusal(answer.error)).toEqual({ code: refusal.code, minWithdrawalAmount: null });
  });

  it('WITHDRAWAL_BELOW_MINIMUM carries the minimum, in minor units', async () => {
    panelReply = panelRefusal(422, 'WITHDRAWAL_BELOW_MINIMUM', `The minimum withdrawal is ${MINIMUM} minor units`, {
      minWithdrawalAmount: MINIMUM,
    });

    const answer = await refusedInTheBrowser();

    expect(answer.status).toBe(422);
    expect(answer.data).toEqual({
      code: 'WITHDRAWAL_BELOW_MINIMUM',
      message: 'The amount is below the minimum withdrawal',
      minWithdrawalAmount: MINIMUM,
    });
    expect(readWithdrawalRefusal(answer.error)).toEqual({ code: 'WITHDRAWAL_BELOW_MINIMUM', minWithdrawalAmount: MINIMUM });
  });

  it('a minimum that is not a whole number is dropped, and the refusal still named', async () => {
    for (const minWithdrawalAmount of ['30700', 307.5, -1, null]) {
      panelReply = panelRefusal(422, 'WITHDRAWAL_BELOW_MINIMUM', 'x', { minWithdrawalAmount });

      const answer = await refusedInTheBrowser();

      expect(answer.data, String(minWithdrawalAmount)).toEqual({
        code: 'WITHDRAWAL_BELOW_MINIMUM',
        message: 'The amount is below the minimum withdrawal',
      });
      expect(readWithdrawalRefusal(answer.error)).toEqual({ code: 'WITHDRAWAL_BELOW_MINIMUM', minWithdrawalAmount: null });
    }
  });
});

describe('what is NOT forwarded', () => {
  it('a 401 or 403 carrying one of these codes: a refusal must never send the customer to sign-in', async () => {
    for (const status of [401, 403]) {
      panelReply = panelRefusal(status, 'PARTNER_NOT_ACTIVE', 'x');

      const answer = await refusedInTheBrowser();

      expect(answer.status, String(status)).toBe(400);
      expect(answer.data).toEqual({ message: 'Withdrawal request failed' });
      expect(readWithdrawalRefusal(answer.error)).toBeNull();
    }
  });

  it('a code the cabinet does not know keeps the generic answer', async () => {
    panelReply = panelRefusal(409, 'SOMETHING_NEW', 'x');

    const answer = await refusedInTheBrowser();

    expect(answer).toMatchObject({ status: 400, data: { message: 'Withdrawal request failed' } });
    expect(readWithdrawalRefusal(answer.error)).toBeNull();
  });

  it('a panel from before the codes still reaches the dialog the old way: a 2xx `{ error }` body', async () => {
    panelReply = { status: 201, body: { error: 'PARTNER_PROGRAM_INVITED_ONLY' } };

    const answer = await createWithdrawal(WITHDRAWAL);

    expect(readWithdrawalAnswer(answer)).toEqual({ kind: 'refused', code: 'INVITED_ONLY' });
  });
});
