import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';

/**
 * Liveness / readiness probes.
 *
 * `/api/v1/health` answers `{status:"ok"}` unconditionally. Boot is fail-closed
 * on Redis, but a Redis outage AFTER boot left the process reporting healthy
 * while every Redis limiter answered 503 and no session resolved — on a split
 * VPS deployment that is the likeliest incident, and the compose healthcheck
 * could not see it.
 *
 * The fix is two probes with different questions, and these tests pin the
 * difference:
 *   • `/live` — is the process alive? No dependency checks, so a dependency
 *     outage can never be answered with a restart (which would not fix it).
 *   • `/ready` — can it serve? Redis only: a hard, co-located dependency.
 *     rezeis-admin is deliberately excluded — it runs on another VPS and reiwa
 *     is built to survive its outage, so folding it in would let a remote
 *     outage mark every local container unhealthy.
 */

interface Driven {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Drives one request through the real app pipeline. Socket-free on purpose:
 * an `IncomingMessage`/`ServerResponse` pair exercises every middleware
 * without binding a port.
 */
async function get(app: ReturnType<typeof createApp>, requestPath: string): Promise<Driven> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  const request = new IncomingMessage(socket);
  request.method = 'GET';
  request.url = requestPath;
  request.headers = { host: '127.0.0.1' };
  const response = new ServerResponse(request);

  const chunks: string[] = [];
  const settled = new Promise<Driven>((resolve) => {
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
        /* non-JSON body — keep the raw string */
      }
      resolve({ status: response.statusCode, body });
      return response;
    };
  });

  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(request, response);
  request.push(null);
  return settled;
}

/** App wired with a Redis whose PING behaviour the test controls. */
function buildApp(ping: () => Promise<string>): {
  readonly app: ReturnType<typeof createApp>;
  readonly ping: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(ping);
  const redis = { ping: spy } as never;
  const webSessionStore = { getRedis: () => redis } as never;
  const app = createApp({
    // `null` stands in for a panel that is absent/unreachable — the remote
    // dependency readiness must ignore.
    adminClient: null,
    sessionStore: null,
    webSessionStore,
    config: {
      NODE_ENV: 'test',
      REIWA_COOKIE_SECURE: false,
      REIWA_ALLOW_INSECURE_COOKIES: true,
      REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
    } as never,
  });
  return { app, ping: spy };
}

const up = (): Promise<string> => Promise.resolve('PONG');
const down = (): Promise<string> => Promise.reject(new Error('ECONNREFUSED'));

describe('liveness and readiness probes', () => {
  it('reports ready when Redis answers, without consulting the panel', async () => {
    // adminClient is null here: readiness must not care that the panel on the
    // other VPS is unreachable.
    const { app } = buildApp(up);
    const res = await get(app, '/api/v1/ready');
    expect(res).toEqual({ status: 200, body: { status: 'ready', redis: 'up' } });
  });

  it('reports 503 not_ready when Redis is down after boot', async () => {
    const { app } = buildApp(down);
    const res = await get(app, '/api/v1/ready');
    // This is the case the old `/health` could not express: the process is
    // running and answering HTTP, but every Redis limiter is returning 503.
    expect(res).toEqual({ status: 503, body: { status: 'not_ready', redis: 'down' } });
  });

  it('reports 503 rather than hanging when Redis stops answering', async () => {
    // A half-open connection makes PING never settle. The probe must bound
    // itself well inside the compose healthcheck timeout instead of holding
    // the request open until Docker gives up.
    const { app } = buildApp(() => new Promise<string>(() => {}));
    const res = await get(app, '/api/v1/ready');
    expect(res).toEqual({ status: 503, body: { status: 'not_ready', redis: 'down' } });
  });

  it('keeps liveness green while Redis is down, and never probes it', async () => {
    const { app, ping } = buildApp(down);
    const res = await get(app, '/api/v1/live');
    // Liveness answering 503 here would tell a supervisor to restart the
    // process — which cannot fix Redis and only produces a crash loop.
    expect(res).toEqual({ status: 200, body: { status: 'ok' } });
    expect(ping).not.toHaveBeenCalled();
  });

  it('keeps /health on its old contract for the panel update-checker', async () => {
    const { app, ping } = buildApp(down);
    const res = await get(app, '/api/v1/health');
    // rezeis-admin's update-checker reads `version` from here and discards any
    // non-2xx response, so this must stay 200 even mid-incident.
    expect(res.status).toBe(200);
    const body = res.body as { status: string; service: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('reiwa-api');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(ping).not.toHaveBeenCalled();
  });

  it('collapses a burst of readiness probes onto a single PING', async () => {
    const { app, ping } = buildApp(up);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => get(app, '/api/v1/ready')),
    );
    for (const res of results) expect(res.status).toBe(200);
    // Unauthenticated and uncached, this endpoint would let anyone turn a
    // request flood into a Redis-command flood.
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('says nothing an anonymous caller could use to probe internals', async () => {
    const { app } = buildApp(down);
    const res = await get(app, '/api/v1/ready');
    const serialized = JSON.stringify(res.body);
    // No host, port, latency, version or upstream error text — only the two
    // words a load balancer needs.
    expect(Object.keys(res.body as object).sort()).toEqual(['redis', 'status']);
    expect(serialized).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|redis:\/\//i);
  });
});
