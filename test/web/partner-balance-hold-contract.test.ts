import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWithdrawal, payWithPartnerBalance } from '@/lib/api-client/partner';
import { apiClient } from '@/lib/api-client/transport';
import { en } from '@/i18n/en';
import { ru } from '@/i18n/ru';
import {
  balanceHoldRefusalMessage,
  formatHoldEnd,
  readBalanceHoldRefusal,
  standingBalanceHold,
} from '@/lib/partner-balance-hold';

import { createPartnerRouter } from '../../src/api/routes/partner.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
// The backend's `Express.Request` augmentation (`webSession`, `context`). This
// file is type-checked by `web/tsconfig.test.json`, whose program holds only
// what its specs import, and the route above is compiled against it.
import '../../src/infrastructure/redis/types.js';

/**
 * The partner balance on hold after a password recovery, end to end: from the
 * panel's refusal to the sentence the customer reads.
 *
 * A stand-in panel answers with the body the panel's error filter writes for
 * the hold (pinned on the panel's side in
 * `rezeis-admin/test/partner-balance-recovery-hold.spec.ts`); the REAL
 * `AdminClient` carries it to the REAL partner router; the page's own axios
 * client — interceptors and all — calls that router over HTTP; and the page's
 * own reader turns the failure into the hold and its sentence.
 *
 * `createWithdrawal` has no caller yet: the partner page's «Вывести средства»
 * button opens nothing. This pins what that caller will get, so the dialog,
 * when it is built, reads the hold with the same `readBalanceHoldRefusal` the
 * two payment pages use — rather than showing "failed".
 */

const HOLD_CODE = 'WITHDRAWAL_HOLD_AFTER_RECOVERY';
/** Fixed, because the sentence is asserted to the minute; it is a hold END, never compared to now here. */
const HOLD_UNTIL = '2026-09-21T11:30:00.000Z';

interface Translator {
  t(key: string, options?: Record<string, unknown>): string;
}

let panelReply: { status: number; body: Record<string, unknown> };
let panel: http.Server;
let cabinet: http.Server;
let adminClient: AdminClient;
let ruT: Translator['t'];
let enT: Translator['t'];

function panelHoldBody(path: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    path,
    requestId: null,
    statusCode: 400,
    message: `The partner balance is on hold until ${HOLD_UNTIL} after an account recovery`,
    errorCode: HOLD_CODE,
    code: HOLD_CODE,
    holdUntil: HOLD_UNTIL,
    error: 'Bad Request',
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
      // The fresh session check both routes ask first (`fresh-session-check.ts`):
      // this customer's sessions were never signed out.
      if ((req.url ?? '').startsWith('/api/internal/web-auth/sessions/state')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessionsRevokedAt: null, now: new Date().toISOString() }));
        return;
      }
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
    next();
  });
  app.use('/api/v1', createPartnerRouter({ adminClient, sessionStore: null, config: loadConfig({ NODE_ENV: 'test' }) }));
  cabinet = http.createServer(app);
  apiClient.defaults.baseURL = `${await listen(cabinet)}/api/v1`;

  // The app's own dictionaries through i18next with the app's interpolation
  // settings (`web/src/i18n/i18n.ts` reads `window` on import, so it is not
  // loaded in this Node-side test).
  const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
  const i18next = requireFromApp('i18next') as {
    createInstance(): {
      init(options: Record<string, unknown>): Promise<unknown>;
      getFixedT(language: string): Translator['t'];
    };
  };
  const instance = i18next.createInstance();
  await instance.init({
    resources: { ru: { translation: ru }, en: { translation: en } },
    lng: 'ru',
    fallbackLng: 'ru',
    interpolation: { escapeValue: false },
  });
  ruT = instance.getFixedT('ru');
  enT = instance.getFixedT('en');
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

const refuseWithdrawal = () =>
  failureOf(() => createWithdrawal({ amount: 10_000, method: 'card', requisites: '4242' }));
const refusePayment = () =>
  failureOf(() => payWithPartnerBalance({ purchaseType: 'NEW', planId: 'plan-1', durationDays: 30 }));

describe('a refusal for the hold reaches the page as the hold', () => {
  it('from a withdrawal request — the contract the withdrawal dialog will read', async () => {
    panelReply = { status: 400, body: panelHoldBody('/api/internal/user/:redacted/partner/withdraw') };

    const failure = await refuseWithdrawal();

    expect(readBalanceHoldRefusal(failure)).toEqual({ until: HOLD_UNTIL });
    const message = balanceHoldRefusalMessage(failure, ruT, 'Europe/Moscow', 'ru');
    expect(message).toBe(
      `Баланс партнёра временно заморожен до ${formatHoldEnd(HOLD_UNTIL, 'Europe/Moscow', 'ru')} после восстановления пароля по ссылке подписки.`,
    );
    // 11:30 UTC is 14:30 in Moscow, and the sentence says which clock it is.
    expect(message).toMatch(/до 21 сентября\D+14:30 GMT\+3 после/);
  });

  it('from a purchase paid with the balance, in the same words', async () => {
    panelReply = { status: 400, body: panelHoldBody('/api/internal/payments/partner-balance/checkout') };

    const failure = await refusePayment();

    expect(readBalanceHoldRefusal(failure)).toEqual({ until: HOLD_UNTIL });
    const message = balanceHoldRefusalMessage(failure, enT, null, 'en');
    expect(message).toBe(
      `Your partner balance is on hold until ${formatHoldEnd(HOLD_UNTIL, null, 'en')} after the password was recovered with the subscription link.`,
    );
    expect(message).toMatch(/until September 21\D+11:30\sAM UTC after/);
  });

  it('is not claimed by any other refusal', async () => {
    panelReply = {
      status: 400,
      body: { statusCode: 400, message: 'Insufficient partner balance', errorCode: 'BAD_REQUEST', error: 'Bad Request' },
    };

    for (const failure of [await refuseWithdrawal(), await refusePayment()]) {
      expect(readBalanceHoldRefusal(failure)).toBeNull();
      expect(balanceHoldRefusalMessage(failure, ruT, 'Europe/Moscow', 'ru')).toBeNull();
    }
  });
});

describe('the end of the hold, as the customer reads it', () => {
  // Matched loosely between the parts: the words joining a date to a time come
  // from the runtime's locale data and have changed between ICU releases.
  it('is in the operator’s time zone, named', () => {
    expect(formatHoldEnd(HOLD_UNTIL, 'Europe/Moscow', 'ru')).toMatch(/^21 сентября\D+14:30 GMT\+3$/);
    expect(formatHoldEnd(HOLD_UNTIL, 'Asia/Yekaterinburg', 'en')).toMatch(/^September 21\D+4:30\sPM GMT\+5$/);
  });

  it('is in UTC, named as such, when the operator set no zone or one this browser does not know', () => {
    expect(formatHoldEnd(HOLD_UNTIL, null, 'ru')).toMatch(/^21 сентября\D+11:30 UTC$/);
    expect(formatHoldEnd(HOLD_UNTIL, 'Mars/Olympus_Mons', 'ru')).toMatch(/^21 сентября\D+11:30 UTC$/);
  });

  it('is no hold at all once it has ended, or when an older panel says nothing', () => {
    const now = Date.parse(HOLD_UNTIL);
    const hold = { until: HOLD_UNTIL, timezone: 'Europe/Moscow' };
    expect(standingBalanceHold(hold, now - 60_000)).toBe(hold);
    expect(standingBalanceHold(hold, now)).toBeNull();
    expect(standingBalanceHold(null, now)).toBeNull();
    expect(standingBalanceHold(undefined, now)).toBeNull();
    expect(standingBalanceHold({ until: 'soon', timezone: null }, now)).toBeNull();
  });
});
