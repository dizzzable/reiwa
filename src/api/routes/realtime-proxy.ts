/**
 * SSE proxy logic for the realtime route.
 *
 * Extracted from `realtime.ts` so the bytes-through-pipe behaviour can
 * be unit-tested without spinning up the full express router + session
 * middleware stack. The router file calls `proxyStream` with a real
 * `AdminClient` + `Response`; tests pass a fake `Response` that records
 * the side effects.
 *
 * Contract:
 *   - SSE response headers are set on the browser side BEFORE the
 *     upstream open, so the EventSource handshake completes even when
 *     the upstream is slow to respond.
 *   - Upstream rejection (4xx/5xx) is rendered as a single
 *     `realtime.unavailable` event, then the response is closed. The
 *     browser's EventSource will reconnect automatically.
 *   - Upstream success: bytes are piped chunk-by-chunk. We do not parse
 *     SSE frames; that's the producer/consumer contract, not ours.
 *   - Browser disconnect: we tear down the upstream stream so undici
 *     stops pulling bytes for a connection no one is reading.
 */
import type { Response } from 'express';

/**
 * Narrow contract — only the bits of `AdminClient` proxyStream needs.
 * Lets tests pass a thin fake without instantiating the full client.
 */
export interface OpenStreamFn {
  openStream(
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: NodeJS.ReadableStream } | null>;
}

export async function proxyStream(
  client: OpenStreamFn,
  userRef: string,
  res: Response,
): Promise<void> {
  // Pre-set SSE headers on the browser side so the connection upgrades
  // cleanly even if the upstream open is slow.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const upstream = await client.openStream(
    `/api/internal/user/${encodeURIComponent(userRef)}/stream`,
  );
  if (upstream === null) {
    res.write('event: realtime.unavailable\n');
    res.write('data: {"reason":"upstream_rejected"}\n\n');
    res.end();
    return;
  }

  const stream = upstream.body;

  // SSE keep-alive. Without periodic traffic an idle connection (no events
  // for a while) can be torn down by the browser/proxy/socket layer, which
  // surfaces as `net::ERR_INCOMPLETE_CHUNKED_ENCODING` in the console. A
  // comment frame every 20s keeps the browser↔reiwa leg warm and lets a
  // failed write reveal a dead client early. `.unref()` so it never keeps
  // the process alive on shutdown / in tests.
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    try {
      // `stream` is an undici Readable that supports `.destroy()`.
      (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
    } catch {
      /* ignore */
    }
  };

  const finish = (): void => {
    cleanup();
    if (!res.writableEnded) res.end();
  };

  heartbeat = setInterval(() => {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      finish();
    }
  }, 20_000);
  heartbeat.unref?.();

  stream.on('data', (chunk: Buffer) => {
    if (res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      finish();
    }
  });
  stream.on('end', finish);
  stream.on('error', finish);

  // Browser disconnected — close upstream so we stop pulling bytes.
  // Express's typings don't expose `res.req` cleanly across versions,
  // so we cast to a narrow `on(event, handler)` shape.
  const reqHandle = (res as unknown as {
    req?: { on?: (event: string, handler: () => void) => void };
  }).req;
  reqHandle?.on?.('close', cleanup);
}
