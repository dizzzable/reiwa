import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthRouter } from '../../src/api/routes/auth.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';

/**
 * A blocked customer opening the Mini App is told the account is blocked —
 * not «Не удалось войти. Попробуйте позже», which never comes true.
 *
 * The panel refuses the bootstrap with `USER_BLOCKED` (rezeis-admin
 * `internal-user-edge.service.ts`): «This account is blocked» for an existing
 * blocked account, «Registration is not available for this account» for an
 * identity on its blocklist. Its error filter strips that code up to Rezeis
 * Admin 0.9.7.70 and forwards it from 0.9.7.71; the bodies below are the
 * filter's own output for both (`$SW/pair/a1-work/filter-body.cjs`). The route
 * reads the code when one came and, only when none did, the exact sentence.
 */

const BOT_TOKEN = '123456:TEST-bot-token-for-bootstrap';
const BOOTSTRAP_PATH = '/api/internal/user/bootstrap';

/** Launch data as Telegram signs it: HMAC-SHA256 keyed by HMAC("WebAppData", bot token). */
function signedLaunchData(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE-test',
    user: JSON.stringify({ id: userId, first_name: 'Anna' }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** The filter's output, key for key; `timestamp` and `requestId` are this file's. */
function filtered(fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-09-26T12:00:00.000Z',
    path: BOOTSTRAP_PATH,
    requestId: 'req-a1-1',
    statusCode: 403,
    ...fields,
  });
}

const BLOCKED = 'This account is blocked';
const BLOCKLISTED = 'Registration is not available for this account';

const bootstrap = vi.fn();
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
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
  app.use(
    '/api/v1',
    createAuthRouter({
      adminClient: { user: { bootstrap }, webAuth: {} } as never,
      sessionStore: null,
      webSessionStore: null,
      config: { NODE_ENV: 'test', BOT_TOKEN } as never,
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bootstrap.mockReset();
});

async function bootstrapRefusedWith(body: string): Promise<{ status: number; body: unknown }> {
  bootstrap.mockRejectedValueOnce(new UpstreamError('POST', BOOTSTRAP_PATH, 403, body));
  const response = await fetch(`${baseUrl}/api/v1/auth/telegram/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `tma ${signedLaunchData(4242)}` },
  });
  return { status: response.status, body: await response.json() };
}

describe('POST /auth/telegram/bootstrap — a blocked account', () => {
  it.each([
    ['a blocked account, code forwarded (0.9.7.71)', filtered({ message: BLOCKED, errorCode: 'USER_BLOCKED', code: 'USER_BLOCKED' })],
    ['a blocked account, code stripped (0.9.7.70)', filtered({ message: BLOCKED, errorCode: 'FORBIDDEN' })],
    ['a blocklisted identity, code forwarded (0.9.7.71)', filtered({ message: BLOCKLISTED, errorCode: 'USER_BLOCKED', code: 'USER_BLOCKED' })],
    ['a blocklisted identity, code stripped (0.9.7.70)', filtered({ message: BLOCKLISTED, errorCode: 'FORBIDDEN' })],
  ])('%s → 403 USER_BLOCKED, with a fixed sentence', async (_name, body) => {
    const answer = await bootstrapRefusedWith(body);

    expect(bootstrap).toHaveBeenCalledOnce();
    expect(answer).toEqual({ status: 403, body: { code: 'USER_BLOCKED', message: 'This account is blocked' } });
  });
});

describe('POST /auth/telegram/bootstrap — what does not change', () => {
  it('an access-mode code keeps its own answer', async () => {
    const answer = await bootstrapRefusedWith(
      filtered({ message: 'Registration is currently disabled', errorCode: 'REGISTRATION_DISABLED', code: 'REGISTRATION_DISABLED' }),
    );

    expect(answer).toEqual({
      status: 403,
      body: { code: 'REGISTRATION_DISABLED', message: 'Registration is currently disabled' },
    });
  });

  it('a code wins over the blocked sentence beside it', async () => {
    const answer = await bootstrapRefusedWith(
      filtered({ message: BLOCKED, errorCode: 'INVITE_REQUIRED', code: 'INVITE_REQUIRED' }),
    );

    expect(answer.body).toMatchObject({ code: 'INVITE_REQUIRED' });
  });

  it.each([
    ['another 403 with no code', filtered({ message: 'Request failed', errorCode: 'FORBIDDEN' })],
    ['the sentence reworded', filtered({ message: 'This account is blocked.', errorCode: 'FORBIDDEN' })],
    ['a code the cabinet does not name', filtered({ message: BLOCKED, errorCode: 'SOMETHING_ELSE', code: 'SOMETHING_ELSE' })],
  ])('%s keeps the generic refusal', async (_name, body) => {
    const answer = await bootstrapRefusedWith(body);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ message: 'Access denied' });
    expect((answer.body as { code?: unknown }).code).not.toBe('USER_BLOCKED');
  });
});
