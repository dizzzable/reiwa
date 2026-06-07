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
import { UpstreamError } from '../../../src/core/errors/index.js';
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

  it('throws a typed UpstreamError carrying status/body for non-2xx', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 409;
      res.end('already exists');
    };
    const err = await transport
      .request<unknown>('POST', '/conflict', { x: 1 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(UpstreamError);
    const upstream = err as UpstreamError;
    expect(upstream.status).toBe(409);
    expect(upstream.body).toBe('already exists');
    expect(upstream.method).toBe('POST');
    expect(upstream.path).toBe('/conflict');
    // 409 is non-retryable; 5xx/408/429 are retryable.
    expect(upstream.isRetryable).toBe(false);
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

describe('AdminTransport — openStream', () => {
  let h: Harness;
  let transport: AdminTransport;

  beforeEach(async () => {
    h = await startTestServer();
    transport = new AdminTransport({ baseUrl: h.baseUrl, apiKey: 'k' });
  });

  afterEach(async () => {
    await transport.close();
    await h.close();
  });

  it('returns the streaming body on a 2xx upstream', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('event: ping\ndata: 1\n\n');
      // Keep the connection open briefly, then close from the server side.
      setTimeout(() => res.end(), 30);
    };
    const result = await transport.openStream('/api/internal/user/abc/stream');
    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    // Drain the body so the test fixture closes cleanly.
    const chunks: Buffer[] = [];
    for await (const chunk of result!.body as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toContain('event: ping');
  });

  it('returns null on a 4xx upstream (and drains the body so the socket is freed)', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 401;
      res.end('not authorised');
    };
    const result = await transport.openStream('/api/internal/user/x/stream');
    expect(result).toBeNull();
  });

  it('returns null on a 5xx upstream', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 503;
      res.end('upstream down');
    };
    const result = await transport.openStream('/api/internal/user/x/stream');
    expect(result).toBeNull();
  });

  it('forwards x-request-id from the active request scope', async () => {
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.end();
    };
    await runWithRequestContext({ requestId: 'sse-trace-1' }, async () => {
      await transport.openStream('/api/internal/user/x/stream');
    });
    expect(h.captured[0].headers['x-request-id']).toBe('sse-trace-1');
  });

  it('merges extraHeaders without dropping signing or trace headers', async () => {
    const t = new AdminTransport({
      baseUrl: h.baseUrl,
      apiKey: 'k',
      sharedSecret: 'shared',
    });
    h.respond = (_req, res) => {
      res.statusCode = 200;
      res.end();
    };
    await runWithRequestContext({ requestId: 'mixed-1' }, async () => {
      await t.openStream('/x', { 'x-custom': 'extra-value' });
    });
    const headers = h.captured[0].headers;
    expect(headers['x-custom']).toBe('extra-value');
    expect(headers['x-request-signature']).toBeDefined();
    expect(headers['x-request-id']).toBe('mixed-1');
    expect(headers['accept']).toBe('text/event-stream');
    await t.close();
  });
});
