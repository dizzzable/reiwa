import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import express from 'express';
import cookieParser from 'cookie-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSupportGuestRouter } from '../../../src/api/routes/support-guest.js';

/**
 * Which IP the guest-support endpoint records.
 *
 * `resolveClientIp` used to read `X-Forwarded-For` directly and take
 * `split(",")[0]` — the LEFTMOST entry. That is the one segment a visitor
 * fully controls: the bundled reverse proxy uses nginx/angie's
 * `$proxy_add_x_forwarded_for`, which APPENDS the real peer address to
 * whatever the client sent. So `X-Forwarded-For: <anything>` from a browser
 * arrived as `<anything>, <real client>` and the leftmost read handed back
 * `<anything>` verbatim — bypassing `trust proxy` entirely.
 *
 * That value reached two places: Turnstile's `remoteip` (poisoning Cloudflare's
 * own risk signal) and the `clientIp` persisted on the ticket an operator reads
 * when judging abuse. Any visitor could make a ticket show any address.
 *
 * `req.ip` with `trust proxy = 1` (as `app.ts` sets, matching the single
 * bundled proxy) resolves the RIGHTMOST entry instead — the hop the trusted
 * proxy itself wrote.
 */

/** Minimal ioredis stand-in covering the guest limiter's calls. */
function fakeRedis(): Record<string, unknown> {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    incr: async (k: string) => {
      const n = parseInt(store.get(k) ?? '0', 10) + 1;
      store.set(k, String(n));
      return n;
    },
    eval: async (_script: string, _keyCount: number, k: string) => {
      const n = parseInt(store.get(k) ?? '0', 10) + 1;
      store.set(k, String(n));
      return [n, 60];
    },
    expire: async () => 1,
    ttl: async () => 60,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
  };
}

function makeApp(
  createGuest: ReturnType<typeof vi.fn>,
  opts?: { turnstileSecret?: string },
): express.Express {
  const adminClient = {
    support: {
      getRuntimeConfig: async () => ({
        enabled: true,
        turnstileSiteKey: '',
        turnstileSecret: opts?.turnstileSecret ?? null,
      }),
      createGuest,
    },
  } as never;
  const config = {
    REIWA_COOKIE_SECURE: false,
    NODE_ENV: 'test',
    REIWA_ALLOW_INSECURE_COOKIES: true,
  } as never;
  const webSessionStore = { getRedis: () => fakeRedis() } as never;
  const app = express();
  // Mirrors `app.ts`: one bundled reverse proxy in front of the process.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', createSupportGuestRouter({ adminClient, config, webSessionStore }));
  return app;
}

/**
 * Drives one request through the app. Socket-free on purpose: no port is
 * bound, and `remoteAddress` stands in for the proxy's peer address.
 */
async function post(
  app: express.Express,
  opts: { path: string; body: unknown; headers?: Record<string, string>; peer?: string },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', {
    value: opts.peer ?? '10.0.0.2',
    configurable: true,
  });
  const request = new IncomingMessage(socket);
  const payload = Buffer.from(JSON.stringify(opts.body));
  request.method = 'POST';
  request.url = opts.path;
  request.headers = {
    host: '127.0.0.1',
    'content-type': 'application/json',
    'content-length': String(payload.length),
    ...opts.headers,
  };
  const response = new ServerResponse(request);

  const chunks: string[] = [];
  const settled = new Promise<{ status: number; body: unknown }>((resolve) => {
    (response as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
      if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
      return true;
    };
    (response as unknown as { end: unknown }).end = (chunk?: unknown): ServerResponse => {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) chunks.push(String(chunk));
      const raw = chunks.join('');
      let body: unknown = raw;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        /* non-JSON body */
      }
      resolve({ status: response.statusCode, body });
      return response;
    };
  });

  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(request, response);
  request.push(payload);
  request.push(null);
  return settled;
}

const okCreate = (): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ token: 'tok-xyz', resumeCode: 'tok-xyz', ticket: { id: 't-1' } }));

/** What a browser sends, after the proxy appended the real peer address. */
const FORGED = '203.0.113.9';
const REAL = '198.51.100.7';
const APPENDED_BY_PROXY = `${FORGED}, ${REAL}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('guest support client IP', () => {
  it('stores the proxy-attested IP, not the forged leftmost X-Forwarded-For', async () => {
    const createGuest = okCreate();
    const res = await post(makeApp(createGuest), {
      path: '/api/v1/support/guest',
      body: { subject: 'Help', message: 'Payment stuck' },
      headers: { 'x-forwarded-for': APPENDED_BY_PROXY },
    });

    expect(res.status).toBe(200);
    expect(createGuest).toHaveBeenCalledTimes(1);
    const recorded = (createGuest.mock.calls[0]?.[0] as { clientIp?: string }).clientIp;
    // The operator must see who actually connected.
    expect(recorded).toBe(REAL);
    expect(recorded).not.toBe(FORGED);
  });

  it('does not hand the forged IP to Turnstile as remoteip', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return { json: async () => ({ success: true }) };
      }),
    );

    const createGuest = okCreate();
    const res = await post(makeApp(createGuest, { turnstileSecret: 'secret' }), {
      path: '/api/v1/support/guest',
      body: { subject: 'Help', message: 'hi', captchaToken: 'tok' },
      headers: { 'x-forwarded-for': APPENDED_BY_PROXY },
    });

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    const form = new URLSearchParams(bodies[0]);
    // Feeding Cloudflare an attacker-chosen origin corrupts the very signal
    // the challenge exists to produce.
    expect(form.get('remoteip')).toBe(REAL);
    expect(form.get('remoteip')).not.toBe(FORGED);
  });

  it('falls back to the peer address when no X-Forwarded-For is present', async () => {
    const createGuest = okCreate();
    const res = await post(makeApp(createGuest), {
      path: '/api/v1/support/guest',
      body: { subject: 'Help', message: 'direct' },
      peer: '10.0.0.9',
    });

    expect(res.status).toBe(200);
    expect((createGuest.mock.calls[0]?.[0] as { clientIp?: string }).clientIp).toBe('10.0.0.9');
  });
});
