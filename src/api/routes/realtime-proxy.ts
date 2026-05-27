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
  telegramId: string,
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
    `/api/internal/user/${encodeURIComponent(telegramId)}/stream`,
  );
  if (upstream === null) {
    res.write('event: realtime.unavailable\n');
    res.write('data: {"reason":"upstream_rejected"}\n\n');
    res.end();
    return;
  }

  const stream = upstream.body;

  const cleanup = (): void => {
    try {
      // `stream` is an undici Readable that supports `.destroy()`.
      (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
    } catch {
      /* ignore */
    }
  };

  stream.on('data', (chunk: Buffer) => {
    if (res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  });
  stream.on('end', () => {
    if (!res.writableEnded) res.end();
  });
  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });

  // Browser disconnected — close upstream so we stop pulling bytes.
  // Express's typings don't expose `res.req` cleanly across versions,
  // so we cast to a narrow `on(event, handler)` shape.
  const reqHandle = (res as unknown as {
    req?: { on?: (event: string, handler: () => void) => void };
  }).req;
  reqHandle?.on?.('close', cleanup);
}
