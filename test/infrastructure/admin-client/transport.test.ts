/**
 * AdminTransport HTTP integration spec.
 *
 * Stands up a tiny `http.createServer` on an ephemeral port (port 0),
 * has the transport hit it and asserts:
 *   - the bearer token is set on every request
 *   - `Content-Type: application/json` is emitted on JSON bodies
 *   - the basePath component of the URL is preserved
 *   - HMAC `x-request-timestamp` / `x-request-signature` headers are
 *     generated when `sharedSecret` is supplied and verify against the
 *     documented signing scheme (METHOD\nPATH\nTIMESTAMP\nSHA256(BODY))
 *   - 204 responses with empty body return `null` cast to T (no
 *     `JSON.parse('')` crash)
 *   - non-2xx upstream responses throw with a structured error message
 *   - `x-request-id` from `runWithRequestContext` is forwarded to the
 *     upstream (Wave 4B trace propagation)
 *
 * Real network rather than `undici`'s `MockAgent` because the
 * transport instantiates its own `Pool` per origin, so the global
 * dispatcher swap does not intercept it.
 */
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminTransport } from '../../../src/infrastructure/admin-client/transport.js';
import { runWithRequestContext } from '../../../src/infrastructure/logger/request-context.js';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Harness {
  server: Server;
  baseUrl: string;
  port: number;
  /** Set by the test before triggering a request. */
  respond: (req: IncomingMessage, res: ServerResponse) => void;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

function startTestServer(): Promise<Harness> {
  const captured: CapturedRequest[] = [];
  let respond: Harness['respond'] = (_req, res) => {
    res.statusCode = 204;
    res.end();
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      respond(req, res);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const harness: Harness = {
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        get respond() {
          return respond;
        },
        set respond(fn) {
          respond = fn;
        },
        captured,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      };
      resolve(harness);
    });
  });
}

describe('AdminTransport — request', () => {
  let h: Harness;
  let transport: AdminTransport;

  beforeEach(async () => {
    h = await startTestServer();
    transport = new AdminTransport({ baseUrl: h.baseUrl, apiKey: 'test-token' });
  });

  afterEach(async () => {
    await transport.close();
    await h.close();
  });

  it('sends Authorization: Bearer <apiKey> on every request', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    };
    await transport.request<unknown>('GET', '/api/internal/test');
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0].headers.authorization).toBe('Bearer test-token');
  });

  it('preserves a baseUrl that has a path prefix', async () => {
    const t = new AdminTransport({ baseUrl: `${h.baseUrl}/v1`, apiKey: 'k' });
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    };
    await t.request<unknown>('GET', '/x');
    expect(h.captured[0].url).toBe('/v1/x');
    await t.close();
  });

  it('parses JSON response body', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ value: 42 }));
    };
    const out = await transport.request<{ value: number }>('GET', '/foo');
    expect(out).toEqual({ value: 42 });
  });

  it('returns null on 204 No Content (no JSON.parse crash)', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 204;
      res.end();
    };
    const out = await transport.request<unknown>('POST', '/bar', { x: 1 });
    expect(out).toBeNull();
  });

  it('throws structured Error on a non-2xx response', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 500;
      res.end('internal boom');
    };
    await expect(transport.request<unknown>('GET', '/oops')).rejects.toThrow(
      'AdminClient: GET /oops → 500: internal boom',
    );
  });

  it('serialises JSON body and sets Content-Type: application/json', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    };
    await transport.request<unknown>('POST', '/echo', { hello: 'world' });
    expect(h.captured[0].body).toBe('{"hello":"world"}');
    expect(h.captured[0].headers['content-type']).toBe('application/json');
  });
});

describe('AdminTransport — HMAC signing', () => {
  let h: Harness;
  let transport: AdminTransport;
  const SECRET = 'shared-secret-test';

  beforeEach(async () => {
    h = await startTestServer();
    transport = new AdminTransport({
      baseUrl: h.baseUrl,
      apiKey: 'test-token',
      sharedSecret: SECRET,
    });
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    };
  });

  afterEach(async () => {
    await transport.close();
    await h.close();
  });

  it('attaches signing headers when sharedSecret is set', async () => {
    await transport.request<unknown>('POST', '/secured', { x: 1 });
    const headers = h.captured[0].headers;
    expect(headers['x-request-timestamp']).toBeDefined();
    expect(headers['x-request-signature']).toBeDefined();
  });

  it('signature matches the documented scheme METHOD\\nPATH\\nTIMESTAMP\\nSHA256(BODY)', async () => {
    const body = { x: 1 };
    await transport.request<unknown>('POST', '/secured', body);
    const captured = h.captured[0];
    const ts = captured.headers['x-request-timestamp'] as string;
    const sig = captured.headers['x-request-signature'] as string;
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const message = ['POST', '/secured', ts, bodyHash].join('\n');
    const expected = createHmac('sha256', SECRET).update(message).digest('hex');
    expect(sig).toBe(expected);
  });

  it('signs an empty body as the SHA256 of the empty string', async () => {
    await transport.request<unknown>('GET', '/no-body');
    const captured = h.captured[0];
    const ts = captured.headers['x-request-timestamp'] as string;
    const sig = captured.headers['x-request-signature'] as string;
    const bodyHash = createHash('sha256').update('').digest('hex');
    const message = ['GET', '/no-body', ts, bodyHash].join('\n');
    const expected = createHmac('sha256', SECRET).update(message).digest('hex');
    expect(sig).toBe(expected);
  });
});

describe('AdminTransport — request-id propagation (Wave 4B)', () => {
  let h: Harness;
  let transport: AdminTransport;

  beforeEach(async () => {
    h = await startTestServer();
    transport = new AdminTransport({ baseUrl: h.baseUrl, apiKey: 'k' });
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    };
  });

  afterEach(async () => {
    await transport.close();
    await h.close();
  });

  it('omits x-request-id when called outside a request scope', async () => {
    await transport.request<unknown>('GET', '/no-trace');
    expect(h.captured[0].headers['x-request-id']).toBeUndefined();
  });

  it('forwards the active request-id from runWithRequestContext', async () => {
    await runWithRequestContext({ requestId: 'trace-abc-123' }, async () => {
      await transport.request<unknown>('GET', '/with-trace');
    });
    expect(h.captured[0].headers['x-request-id']).toBe('trace-abc-123');
  });
});
