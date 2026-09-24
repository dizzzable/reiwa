import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createPartnerRouter } from '../../src/api/routes/partner.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
import { sendSocketless } from './socketless-request.js';

/**
 * The partner balance on hold after a password recovery — what the customer's
 * browser actually receives from the two routes that move partner money.
 *
 * For three days after a password reset by subscription link the panel refuses
 * both a withdrawal request and a purchase paid with the balance, with
 * `WITHDRAWAL_HOLD_AFTER_RECOVERY` and the end of the hold. Both routes used to
 * hand every refusal to `sendSafeError`, so the customer read "Withdrawal
 * request failed" — nothing about a hold, nothing about when it ends.
 *
 * Nothing here is a double of the cabinet's error path: the REAL `AdminClient`
 * and its transport call a stand-in panel over HTTP, the transport throws its
 * real `UpstreamError`, and the REAL router answers. The stand-in replies with
 * the body the panel's `AdminSafeExceptionFilter` writes for this refusal, key
 * for key — `rezeis-admin/test/partner-balance-recovery-hold.spec.ts` pins that
 * body on the panel's side, so a change there is a change here.
 */

const HOLD_CODE = 'WITHDRAWAL_HOLD_AFTER_RECOVERY';
const USER_ID = 'user-cuid-1';
const WITHDRAW_PATH = `/api/internal/user/${USER_ID}/partner/withdraw`;
const PAY_PATH = '/api/internal/payments/partner-balance/checkout';

/** Relative: an absolute fixture date in this ecosystem once aged into a defect. */
const HOLD_UNTIL = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

/** The panel's refusal, as its error filter serialises it (the path redacted by the filter). */
function panelHoldBody(path: string, holdUntil: unknown = HOLD_UNTIL): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    path,
    requestId: null,
    statusCode: 400,
    message: `The partner balance is on hold until ${String(holdUntil)} after an account recovery`,
    errorCode: HOLD_CODE,
    code: HOLD_CODE,
    holdUntil,
    error: 'Bad Request',
  };
}

interface PanelReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Stand {
  readonly calls: string[];
  reply: PanelReply;
  /** The cabinet, driven socketless (`socketless-request.ts` says why). */
  readonly cabinet: express.Express;
  close(): Promise<void>;
}

const stands: Stand[] = [];

afterEach(async () => {
  await Promise.all(stands.splice(0).map((stand) => stand.close()));
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stand-in panel plus the real cabinet in front of it. */
async function stand(reply: PanelReply): Promise<Stand> {
  const calls: string[] = [];
  const state = { reply };
  const panel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // The fresh session check both routes ask first (`fresh-session-check.ts`):
      // this customer's sessions were never signed out.
      if ((req.url ?? '').startsWith('/api/internal/web-auth/sessions/state')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessionsRevokedAt: null, now: new Date().toISOString() }));
        return;
      }
      calls.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.statusCode = state.reply.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state.reply.body));
    });
  });
  const panelUrl = await listen(panel);
  const adminClient = new AdminClient(panelUrl, 'internal-token');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = { userId: USER_ID, createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
    next();
  });
  app.use(
    '/api/v1',
    createPartnerRouter({ adminClient, sessionStore: null, config: loadConfig({ NODE_ENV: 'test' }) }),
  );

  const created: Stand = {
    calls,
    get reply() {
      return state.reply;
    },
    set reply(next: PanelReply) {
      state.reply = next;
    },
    cabinet: app,
    close: async () => {
      await adminClient.close();
      await new Promise<void>((resolve) => panel.close(() => resolve()));
    },
  };
  stands.push(created);
  return created;
}

async function post(target: Stand, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await sendSocketless(target.cabinet, { method: 'POST', url: path, body });
  return { status: response.status, body: response.body ?? null };
}

const WITHDRAWAL = { amount: 10_000, method: 'card', requisites: '4242' };
const PURCHASE = { purchaseType: 'NEW', planId: 'plan-1', durationDays: 30 };

const FORWARDED = {
  code: HOLD_CODE,
  holdUntil: HOLD_UNTIL,
  message: 'The partner balance is on hold after an account recovery',
};

describe('the partner balance hold reaches the customer', () => {
  it('forwards the code and the end of the hold from a refused withdrawal request', async () => {
    const target = await stand({ status: 400, body: panelHoldBody('/api/internal/user/:redacted/partner/withdraw') });

    const answer = await post(target, '/api/v1/partner/withdraw', WITHDRAWAL);

    expect(target.calls).toEqual([`POST ${WITHDRAW_PATH}`]);
    expect(answer.status).toBe(400);
    // Exactly these three keys: the panel's path, request id and sentence stay behind.
    expect(answer.body).toEqual(FORWARDED);
  });

  it('forwards the same from a refused purchase paid with the balance', async () => {
    const target = await stand({ status: 400, body: panelHoldBody(PAY_PATH) });

    const answer = await post(target, '/api/v1/partner/pay', PURCHASE);

    expect(target.calls).toEqual([`POST ${PAY_PATH}`]);
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(FORWARDED);
  });

  it('sends null for an end of hold that is not an exact instant, and still names the hold', async () => {
    for (const holdUntil of ['in three days', '2026-09-21', 1_790_000_000_000, null]) {
      const target = await stand({ status: 400, body: panelHoldBody(PAY_PATH, holdUntil) });

      const answer = await post(target, '/api/v1/partner/pay', PURCHASE);

      expect(answer.body, String(holdUntil)).toEqual({ ...FORWARDED, holdUntil: null });
    }
  });
});

describe('every other refusal keeps the generic answer', () => {
  it('says only "failed" for the other refusals of a withdrawal', async () => {
    const target = await stand({
      status: 400,
      body: {
        timestamp: new Date().toISOString(),
        path: '/api/internal/user/:redacted/partner/withdraw',
        requestId: null,
        statusCode: 400,
        message: 'Insufficient partner balance',
        errorCode: 'BAD_REQUEST',
        error: 'Bad Request',
      },
    });

    const answer = await post(target, '/api/v1/partner/withdraw', WITHDRAWAL);

    expect(answer).toEqual({ status: 400, body: { message: 'Withdrawal request failed' } });
  });

  it('keeps the subscription-limit answer of the balance checkout', async () => {
    const target = await stand({
      status: 400,
      body: { statusCode: 400, message: 'x', errorCode: 'SUBSCRIPTION_LIMIT_REACHED', code: 'SUBSCRIPTION_LIMIT_REACHED' },
    });

    const answer = await post(target, '/api/v1/partner/pay', PURCHASE);

    expect(answer).toEqual({ status: 400, body: { code: 'SUBSCRIPTION_LIMIT_REACHED', message: 'Subscription limit reached' } });
  });

  it('forwards the trial conversion the balance checkout asks for, typed', async () => {
    const target = await stand({
      status: 400,
      body: { statusCode: 400, message: 'x', errorCode: 'TRIAL_UPGRADE_REQUIRED', code: 'TRIAL_UPGRADE_REQUIRED' },
    });

    const answer = await post(target, '/api/v1/partner/pay', PURCHASE);

    expect(answer).toEqual({
      status: 400,
      body: { code: 'TRIAL_UPGRADE_REQUIRED', message: 'The purchase converts the trial subscription' },
    });
  });

  it('forwards the refusal of a balance renewal for a subscription with no end date, typed', async () => {
    // The panel never renews a subscription with no end date; the renewal page
    // says so instead of "could not pay from the balance".
    const target = await stand({
      status: 400,
      body: { statusCode: 400, message: 'x', errorCode: 'SUBSCRIPTION_IS_LIFETIME', code: 'SUBSCRIPTION_IS_LIFETIME' },
    });

    const answer = await post(target, '/api/v1/partner/pay', PURCHASE);

    expect(answer).toEqual({
      status: 400,
      body: { code: 'SUBSCRIPTION_IS_LIFETIME', message: 'The subscription has no end date and is never renewed.' },
    });
  });

  it('answers an older panel — whose filter strips the code — as before', async () => {
    // A panel from before the allowlist entry: the code and the end of the
    // hold never leave it, and its sentence is not forwarded either.
    const target = await stand({
      status: 400,
      body: {
        timestamp: new Date().toISOString(),
        path: '/api/internal/user/:redacted/partner/withdraw',
        requestId: null,
        statusCode: 400,
        message: `Withdrawals are on hold until ${HOLD_UNTIL} after an account recovery`,
        errorCode: 'BAD_REQUEST',
        error: 'Bad Request',
      },
    });

    const withdraw = await post(target, '/api/v1/partner/withdraw', WITHDRAWAL);
    const pay = await post(target, '/api/v1/partner/pay', PURCHASE);

    expect(withdraw).toEqual({ status: 400, body: { message: 'Withdrawal request failed' } });
    expect(pay).toEqual({ status: 400, body: { message: 'Partner balance payment failed' } });
  });

  it('does not treat the code as a hold on anything but a 400', async () => {
    const target = await stand({ status: 409, body: panelHoldBody(PAY_PATH) });

    const answer = await post(target, '/api/v1/partner/pay', PURCHASE);

    expect(answer).toEqual({ status: 400, body: { message: 'Partner balance payment failed' } });
  });
});
