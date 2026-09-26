import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProfileRouter } from '../../src/api/routes/profile.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';

/**
 * An operator blocks a customer who is signed in: the cabinet session must end
 * the next time the cabinet asks the panel about that account.
 *
 * Driven through the REAL routes that ask (`/session`, the probe the SPA makes
 * on every load, and `/me`), the REAL admin transport, and a stand-in panel
 * that answers with the exact bytes its `AdminSafeExceptionFilter` writes for
 * the blocked session read (`internal-user.service.ts#getSession`, produced by
 * running the filter: `$SW/pair/a1-work/filter-body.cjs`). The helper used to
 * read only the code, which the filter stripped until Rezeis Admin 0.9.7.71 —
 * so against every released panel the session survived the block.
 */

const USER_ID = 'user-cuid-1';
const SESSION_PATH = `/api/internal/user/session?userId=${USER_ID}`;

/** The filter's output, key for key; `timestamp` and `requestId` are this file's. */
function filtered(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: '2026-09-26T12:00:00.000Z',
    path: '/api/internal/user/session',
    requestId: 'req-a1-1',
    statusCode: 403,
    ...fields,
  };
}

const FORWARDS_THE_CODE = filtered({ message: 'USER_BLOCKED', errorCode: 'USER_BLOCKED', code: 'USER_BLOCKED' });
const STRIPS_THE_CODE = filtered({ message: 'USER_BLOCKED', errorCode: 'FORBIDDEN' });
/** A 403 that is not a block: the filter's scrubbed sentence, no code. */
const OTHER_FORBIDDEN = filtered({ message: 'Request failed', errorCode: 'FORBIDDEN' });

let panelReply: { status: number; body: Record<string, unknown> };
let panelCalls: string[];
let panel: http.Server;
let cabinet: http.Server;
let cabinetUrl: string;
let adminClient: AdminClient;
const destroyWebSession = vi.fn(async () => undefined);

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
  app.use((req, _res, next) => {
    req.webSession = { userId: USER_ID, createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
    req.webSessionId = 'session-of-the-blocked-customer';
    req.destroyWebSession = destroyWebSession;
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
  app.use('/api/v1', createProfileRouter({ adminClient, sessionStore: null, config: loadConfig({ NODE_ENV: 'test' }) }));
  cabinet = http.createServer(app);
  cabinetUrl = await listen(cabinet);
});

beforeEach(() => {
  panelCalls = [];
  destroyWebSession.mockClear();
});

afterAll(async () => {
  await adminClient.close();
  await Promise.all([panel, cabinet].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${cabinetUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

describe.each(['/api/v1/session', '/api/v1/me'])('%s for a customer blocked while signed in', (route) => {
  it('ends the session against a panel that forwards USER_BLOCKED (0.9.7.71 and later)', async () => {
    panelReply = { status: 403, body: FORWARDS_THE_CODE };

    const answer = await get(route);

    expect(panelCalls).toEqual([`GET ${SESSION_PATH}`]);
    expect(destroyWebSession).toHaveBeenCalledOnce();
    expect(answer).toEqual({ status: 200, body: null });
  });

  it('ends it against a panel that strips the code (0.9.7.70 and older), by the status and the exact sentence', async () => {
    panelReply = { status: 403, body: STRIPS_THE_CODE };

    const answer = await get(route);

    expect(destroyWebSession).toHaveBeenCalledOnce();
    expect(answer).toEqual({ status: 200, body: null });
  });

  it('keeps the session for a 403 that is not a block', async () => {
    panelReply = { status: 403, body: OTHER_FORBIDDEN };

    await get(route);

    expect(panelCalls).toEqual([`GET ${SESSION_PATH}`]);
    expect(destroyWebSession).not.toHaveBeenCalled();
  });
});
