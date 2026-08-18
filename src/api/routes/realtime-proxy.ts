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
 *   - A `retry:` line is written at the head of every stream. On the
 *     failure paths below the browser never sees an *error* — headers were
 *     already flushed with a 200, so from its point of view the connection
 *     SUCCEEDED and then ended — it only sees the close, and reconnects
 *     after its own reconnection time. That value is therefore the only
 *     lever anyone has on reconnect pressure during a panel outage, and
 *     only the server can set it.
 *   - Upstream rejection (4xx/5xx) is rendered as a single
 *     `realtime.unavailable` event, then the response is closed. The
 *     browser's EventSource will reconnect automatically.
 *   - Upstream connection failures are converted into the same graceful SSE
 *     response instead of escaping after headers were flushed and making
 *     Express reset the browser connection.
 *   - Upstream silence is treated as death: see `UPSTREAM_IDLE_TIMEOUT_MS`.
 *   - Upstream success: bytes are piped chunk-by-chunk. We do not parse
 *     SSE frames; that's the producer/consumer contract, not ours.
 *   - Browser disconnect: we tear down the upstream stream so undici
 *     stops pulling bytes for a connection no one is reading.
 */
import type { Response } from 'express';

/**
 * How long the upstream may stay SILENT before we treat the connection as
 * dead and close the subscriber's stream.
 *
 * Why a watchdog exists at all
 *   `AdminTransport.openStream` sets `bodyTimeout: 0` — an SSE body
 *   legitimately never ends, so undici's idle detection has to be off.
 *   That also means undici will never notice a peer that stops sending
 *   WITHOUT a FIN/RST: a network partition, a frozen VPS, a stateful
 *   firewall expiring an idle flow. On a single host a dead panel RSTs
 *   immediately and `stream.on('error')` fires, which is why this could
 *   not happen over the docker bridge; with the panel on its own VPS it
 *   can. Nothing else in here reacts to silence — only to `end` and
 *   `error`. Worse, the `: ping` below keeps writing to the browser, so
 *   `EventSource.readyState` stays OPEN and `onerror` never fires: the
 *   subscriber holds a live-looking stream that will never deliver another
 *   event until the page is reloaded.
 *
 * Why 60s
 *   The panel writes a `: keepalive` comment every 25s
 *   (`internal-user-realtime.controller.ts`, HEARTBEAT_INTERVAL_MS), so on
 *   a healthy link bytes arrive at least that often even with zero events.
 *   60s is 2.4x that window: it absorbs one COMPLETELY missed keepalive
 *   plus ~10s of slack — a TCP retransmit burst alone eats 20s+ once RTO
 *   doubling gets going, and a GC pause or an nginx worker reload adds more
 *   — while bounding how long a subscriber can sit on a dead stream to
 *   under a minute. Under ~40s this starts killing healthy streams on a
 *   single lost keepalive, which is a worse bug than the one it guards
 *   against; much over 60s it stops being a watchdog and becomes a
 *   formality.
 *
 * If the panel's heartbeat interval is ever raised, this has to move with it.
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * `retry:` written at the head of every stream. 3s is what browsers already
 * use by default, so healthy behaviour is unchanged — the reason to send it
 * at all is to RESET `CLIENT_BACKOFF_RETRY_MS` once the panel is back. Per
 * the SSE spec the reconnection time is a property of the EventSource
 * object and survives reconnects, so a client that saw one outage would
 * otherwise keep the long backoff for the life of the page.
 */
export const CLIENT_RETRY_MS = 3_000;

/**
 * `retry:` written whenever we close because the panel is unreachable.
 *
 * At the ~3s default, a panel outage has every subscriber re-opening ~20
 * times a minute, and each re-open costs reiwa a fresh upstream connection
 * carrying a 10s headers timeout. 15s cuts that by 5x while keeping
 * recovery latency after the panel returns under a quarter of a minute —
 * well inside the panel's own restart time, so nobody notices it.
 */
export const CLIENT_BACKOFF_RETRY_MS = 15_000;

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

/**
 * Emit the `realtime.unavailable` frame, then close.
 *
 * The payload carries the full `UserRealtimeEvent` shape rather than a bare
 * `{reason}`: the SPA registers a listener for this event NAME (a typed SSE
 * event never reaches the generic `message` handler, so an unregistered
 * name is silently dropped), and the hook's raw-stream observer is typed.
 *
 * `severity: INFO` + `category: NOTIFICATION` is deliberate. This is a
 * transport-state frame, and that pair is exactly the combination the
 * client's toast logic ignores — so even if someone later routes it through
 * the generic handler, a panel blip can never become a toast every
 * `CLIENT_BACKOFF_RETRY_MS`.
 */
function closeUnavailable(res: Response, reason: string): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify({
    type: 'realtime.unavailable',
    category: 'NOTIFICATION',
    severity: 'INFO',
    message: 'Realtime backend unavailable',
    metadata: { reason },
    timestamp: new Date().toISOString(),
  });
  res.write(`retry: ${CLIENT_BACKOFF_RETRY_MS}\n\n`);
  res.write('event: realtime.unavailable\n');
  res.write(`data: ${payload}\n\n`);
  res.end();
}

export async function proxyStream(
  client: OpenStreamFn,
  userRef: string,
  res: Response,
  onUpstreamError?: (error: unknown) => void,
): Promise<void> {
  // Pre-set SSE headers on the browser side so the connection upgrades
  // cleanly even if the upstream open is slow.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Pin the reconnection time before anything can go wrong — this is the
  // reset half of the backoff pair (see CLIENT_RETRY_MS).
  res.write(`retry: ${CLIENT_RETRY_MS}\n\n`);

  let upstream: Awaited<ReturnType<OpenStreamFn['openStream']>>;
  try {
    upstream = await client.openStream(
      `/api/internal/user/${encodeURIComponent(userRef)}/stream`,
    );
  } catch (error) {
    onUpstreamError?.(error);
    closeUnavailable(res, 'upstream_connection_failed');
    return;
  }
  if (upstream === null) {
    closeUnavailable(res, 'upstream_rejected');
    return;
  }

  const stream = upstream.body;

  // SSE keep-alive. Without periodic traffic an idle connection (no events
  // for a while) can be torn down by the browser/proxy/socket layer, which
  // surfaces as `net::ERR_INCOMPLETE_CHUNKED_ENCODING` in the console. A
  // comment frame every 20s keeps the browser<->reiwa leg warm and lets a
  // failed write reveal a dead client early. `.unref()` so it never keeps
  // the process alive on shutdown / in tests.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
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

  // Upstream idle watchdog — see UPSTREAM_IDLE_TIMEOUT_MS. Rearmed on EVERY
  // upstream byte, not on parsed events: the panel's liveness signal is a
  // `: keepalive` COMMENT line, so a watchdog that only counted events would
  // tear down every healthy idle stream right on schedule.
  const armIdleWatchdog = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      cleanup();
      // Say why before closing: an idle-timeout close is otherwise
      // indistinguishable on the wire from a clean upstream end, and this
      // reason is the only evidence a silent partition ever leaves behind.
      closeUnavailable(res, 'upstream_idle_timeout');
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  armIdleWatchdog();

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
    armIdleWatchdog();
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
