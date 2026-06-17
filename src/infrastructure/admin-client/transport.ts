/**
 * AdminTransport — HTTP-only layer underneath the namespace facade.
 *
 * Owns the persistent undici `Pool`, the bearer-token + HMAC signing
 * scheme, the request/response JSON envelope and the SSE streaming
 * helper used by the realtime route. Namespaces consume it via the
 * narrow `request` / `openStream` methods and never see the underlying
 * pool.
 *
 * Connection model (unchanged from the legacy `AdminClient`):
 *   - one persistent `Pool` per upstream origin, lazily created on first
 *     request, reused for the lifetime of the transport.
 *   - HTTP/1.1 keep-alive with up to 50 concurrent connections per origin,
 *     pipelining=1 (semantics identical to fetch but with aggressive
 *     socket reuse — roughly 2× throughput vs. global fetch under load).
 *   - default timeouts: 30s body, 10s headers — enough for slow upstream
 *     ops (image generation, payment provider round-trips), short enough
 *     to fail fast on stalled sockets.
 *
 * Auth: `Authorization: Bearer <apiKey>` on every request. When
 * `sharedSecret` is set, an HMAC-SHA256 signature is added via the
 * `x-request-timestamp` / `x-request-signature` header pair so the
 * upstream guard can verify request integrity.
 */
import { Pool } from 'undici';

import { UpstreamError } from '../../core/errors/index.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../lib/internal-hmac.js';
import {
  REQUEST_ID_HEADER,
  getCurrentRequestId,
} from '../logger/index.js';

const DEFAULT_POOL_CONNECTIONS = 50;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 60_000;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface AdminTransportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly sharedSecret?: string | null;
}

export class AdminTransport {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly apiKey: string;
  private readonly sharedSecret: string | null;
  private readonly pool: Pool;

  constructor(options: AdminTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    const parsed = new URL(this.baseUrl);
    this.basePath = parsed.pathname.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.sharedSecret = options.sharedSecret ?? null;
    // `Pool` is keyed by origin (scheme + host + port). Any path component
    // on baseUrl is preserved separately and prepended on every call.
    this.pool = new Pool(parsed.origin, {
      connections: DEFAULT_POOL_CONNECTIONS,
      pipelining: 1,
      keepAliveTimeout: DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
      bodyTimeout: DEFAULT_BODY_TIMEOUT_MS,
    });
  }

  /**
   * Closes the pool gracefully. Call from a SIGTERM/SIGINT handler so
   * in-flight requests finish before the process exits.
   */
  async close(): Promise<void> {
    await this.pool.close();
  }

  async request<T>(
    method: HttpMethod | string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const fullPath = `${this.basePath}${path}`;
    const upper = method.toUpperCase() as HttpMethod;
    const signingHeaders = this.buildSigningHeaders(upper, path, body);
    const traceHeaders = this.buildTraceHeaders();

    const response = await this.pool.request({
      method: upper,
      path: fullPath,
      headers: {
        'Content-Type': 'application/json',
        // Caller-supplied headers (e.g. the guest support token) are applied
        // first so they can never override auth / trace / signing below.
        ...extraHeaders,
        Authorization: `Bearer ${this.apiKey}`,
        ...traceHeaders,
        ...signingHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const text = await response.body.text().catch(() => 'Unknown error');
      // Typed failure: callers (route handlers, use-cases) classify on
      // `status` / `isRetryable` / `isAuthFailure` instead of string-matching
      // the message. The `Error.message` format is preserved
      // (`AdminClient: <method> <path> → <status>: <body>`) for back-compat
      // with logs and any remaining text-based callers.
      throw new UpstreamError(upper, path, response.statusCode, text);
    }

    // 204 No Content / empty response handling — return null cast to T so
    // callers that don't expect a body don't trip JSON.parse on "".
    const raw = await response.body.text();
    if (raw.length === 0) return null as unknown as T;
    return JSON.parse(raw) as T;
  }

  /**
   * Opens a streaming GET against an upstream endpoint and returns the
   * raw response body as a Node `Readable`. Used for SSE proxying so
   * reiwa can `.pipe()` the stream straight back to the browser without
   * buffering the whole body.
   *
   * Returns `null` when the upstream rejects the connection (4xx/5xx).
   */
  async openStream(
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: NodeJS.ReadableStream } | null> {
    const fullPath = `${this.basePath}${path}`;
    const signingHeaders = this.buildSigningHeaders('GET', path);
    const traceHeaders = this.buildTraceHeaders();
    const response = await this.pool.request({
      method: 'GET',
      path: fullPath,
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        Authorization: `Bearer ${this.apiKey}`,
        ...traceHeaders,
        ...signingHeaders,
        ...extraHeaders,
      },
      // SSE responses don't have a meaningful Content-Length and stream
      // for as long as the user keeps the tab open. Disable the body
      // timeout entirely so undici doesn't yank the socket.
      bodyTimeout: 0,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
    });
    if (response.statusCode >= 400) {
      // Drain so the socket returns to the pool.
      await response.body.text().catch(() => undefined);
      return null;
    }
    return { status: response.statusCode, body: response.body };
  }

  /**
   * Issues a GET and returns the raw response body as a Node `Readable`
   * together with the upstream `Content-Type` and `Content-Length`. Used to
   * proxy permissioned binary downloads (e.g. support attachments) straight
   * back to the browser without buffering. Returns `null` on a 4xx/5xx.
   */
  async fetchBinary(
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{
    status: number;
    contentType: string | null;
    contentLength: number | null;
    body: NodeJS.ReadableStream;
  } | null> {
    const fullPath = `${this.basePath}${path}`;
    const signingHeaders = this.buildSigningHeaders('GET', path);
    const traceHeaders = this.buildTraceHeaders();
    const response = await this.pool.request({
      method: 'GET',
      path: fullPath,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...traceHeaders,
        ...signingHeaders,
        ...extraHeaders,
      },
    });
    if (response.statusCode >= 400) {
      await response.body.text().catch(() => undefined);
      return null;
    }
    const contentType = headerValue(response.headers['content-type']);
    const lengthRaw = headerValue(response.headers['content-length']);
    const contentLength = lengthRaw !== null ? Number.parseInt(lengthRaw, 10) : null;
    return {
      status: response.statusCode,
      contentType,
      contentLength: Number.isFinite(contentLength as number) ? contentLength : null,
      body: response.body,
    };
  }

  private buildSigningHeaders(method: HttpMethod, path: string, body?: unknown): Record<string, string> {
    if (!this.sharedSecret) return {};
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const { timestamp, signature } = buildInternalSignature({
      secret: this.sharedSecret,
      method,
      path,
      body: bodyStr,
    });
    return {
      [REQUEST_TIMESTAMP_HEADER]: timestamp,
      [REQUEST_SIGNATURE_HEADER]: signature,
    };
  }

  /**
   * Forward the active request-id from AsyncLocalStorage onto the
   * upstream call so admin-side logs join the same trace. When called
   * outside a request scope (worker tick, bot dispatcher cold start)
   * the id is omitted; admin's own request-id middleware then
   * synthesises a fresh one rather than trusting a placeholder.
   */
  private buildTraceHeaders(): Record<string, string> {
    const id = getCurrentRequestId();
    if (!id) return {};
    return { [REQUEST_ID_HEADER]: id };
  }
}

/** Normalize an undici header (string | string[] | undefined) to a string. */
function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}
