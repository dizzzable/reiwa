/**
 * realtime-proxy specs.
 *
 * Drives proxyStream with a fake `OpenStreamFn` + a fake `Response`
 * that records calls. The upstream stream is a real `Readable.from`
 * so the `data` / `end` event wiring is exercised end-to-end without
 * a real HTTP server.
 *
 * Pinned behaviours:
 *   - SSE response headers (Content-Type, Cache-Control, Connection,
 *     X-Accel-Buffering) are set BEFORE openStream so the browser
 *     handshake completes even if upstream is slow.
 *   - Upstream rejection (null) emits a single `realtime.unavailable`
 *     event then ends.
 *   - Upstream connection failures are reported as graceful SSE events.
 *   - Upstream success pipes every chunk through to res.write.
 *   - Stream `end` closes the response exactly once.
 *   - Browser `close` event tears down the upstream stream.
 *   - URL-encodes the telegramId path segment.
 *   - An upstream that STOPS SENDING without ever closing (no `end`, no
 *     `error` — a partition, a frozen host, a firewall dropping an idle
 *     flow) still results in the subscriber's response ending, and a bare
 *     `: keepalive` comment counts as liveness so healthy eventless streams
 *     survive indefinitely. Driven on fake timers against a stalled
 *     upstream, because those are the only two properties that matter and
 *     asserting "a timer was scheduled" would prove neither.
 *   - `retry:` pacing: pinned at the head of every stream, backed off when
 *     the panel is unreachable.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLIENT_BACKOFF_RETRY_MS,
  CLIENT_RETRY_MS,
  UPSTREAM_IDLE_TIMEOUT_MS,
  proxyStream,
  type OpenStreamFn,
} from '../../../src/api/routes/realtime-proxy.js';
import type { Response } from 'express';

interface FakeRes {
  setHeader: ReturnType<typeof vi.fn>;
  flushHeaders: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
  req?: { on?: (event: string, handler: () => void) => void };
}

function buildFakeRes(over: Partial<FakeRes> = {}): FakeRes {
  let ended = false;
  const res: FakeRes = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(() => {
      ended = true;
    }),
    get writableEnded() {
      return ended;
    },
    set writableEnded(v: boolean) {
      ended = v;
    },
    ...over,
  };
  return res;
}

function rejectingClient(): OpenStreamFn {
  return { openStream: vi.fn().mockResolvedValue(null) };
}

function streamingClient(stream: NodeJS.ReadableStream, status = 200): OpenStreamFn {
  return { openStream: vi.fn().mockResolvedValue({ status, body: stream }) };
}

describe('proxyStream', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets SSE headers + flushes them BEFORE opening the upstream', async () => {
    const opened = vi.fn().mockResolvedValue(null);
    const res = buildFakeRes();
    const flushOrder: string[] = [];
    res.flushHeaders = vi.fn(() => flushOrder.push('flush'));
    const client: OpenStreamFn = {
      openStream: vi.fn(async (path) => {
        flushOrder.push('openStream');
        return opened(path) as null;
      }),
    };
    await proxyStream(client, '42', res as unknown as Response);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(flushOrder).toEqual(['flush', 'openStream']);
  });

  it('encodes the telegramId in the upstream path', async () => {
    const client = rejectingClient();
    const res = buildFakeRes();
    await proxyStream(client, 'tg user/42', res as unknown as Response);
    expect(client.openStream).toHaveBeenCalledWith(
      '/api/internal/user/tg%20user%2F42/stream',
    );
  });

  it('emits realtime.unavailable + ends when upstream rejects', async () => {
    const client = rejectingClient();
    const res = buildFakeRes();
    await proxyStream(client, '1', res as unknown as Response);
    expect(res.write).toHaveBeenCalledWith('event: realtime.unavailable\n');
    const written = res.write.mock.calls.map((c) => String(c[0]));
    expect(written.some((w) => w.includes('"reason":"upstream_rejected"'))).toBe(true);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('converts an upstream connection failure into a graceful SSE event', async () => {
    const error = new Error('connect ECONNREFUSED');
    const onUpstreamError = vi.fn();
    const client: OpenStreamFn = {
      openStream: vi.fn().mockRejectedValue(error),
    };
    const res = buildFakeRes();

    await expect(
      proxyStream(client, '1', res as unknown as Response, onUpstreamError),
    ).resolves.toBeUndefined();

    expect(onUpstreamError).toHaveBeenCalledWith(error);
    expect(res.write).toHaveBeenCalledWith('event: realtime.unavailable\n');
    const written = res.write.mock.calls.map((c) => String(c[0]));
    expect(
      written.some((w) => w.includes('"reason":"upstream_connection_failed"')),
    ).toBe(true);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('pipes every upstream chunk through to res.write', async () => {
    const stream = Readable.from([
      Buffer.from('event: ping\ndata: 1\n\n'),
      Buffer.from('data: 2\n\n'),
    ]);
    const client = streamingClient(stream);
    const res = buildFakeRes();
    await proxyStream(client, '1', res as unknown as Response);
    // Wait for the Readable to drain into the data listener.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const written = res.write.mock.calls.map((c) => (c[0] as Buffer).toString());
    expect(written).toContain('event: ping\ndata: 1\n\n');
    expect(written).toContain('data: 2\n\n');
  });

  it('closes the response exactly once on upstream end', async () => {
    const stream = Readable.from([Buffer.from('a')]);
    const client = streamingClient(stream);
    const res = buildFakeRes();
    await proxyStream(client, '1', res as unknown as Response);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('skips res.write after writableEnded becomes true', async () => {
    const stream = Readable.from([Buffer.from('first'), Buffer.from('second')]);
    const client = streamingClient(stream);
    const res = buildFakeRes();
    // Force writableEnded after the first BUFFER chunk. The stream now opens
    // with a `retry:` preamble, and this spec is about the pipe — flipping on
    // the very first write would spend the budget on the preamble and pass
    // without the pipe ever being exercised.
    res.write = vi.fn((chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) res.writableEnded = true;
      return true;
    });
    await proxyStream(client, '1', res as unknown as Response);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // The preamble plus the first chunk; the second chunk is skipped.
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.write.mock.calls.map((c) => String(c[0]))).toEqual([
      `retry: ${CLIENT_RETRY_MS}\n\n`,
      'first',
    ]);
  });

  it('tears down the upstream stream when the browser closes the connection', async () => {
    const destroy = vi.fn();
    const stream = Object.assign(Readable.from([]), { destroy });
    const client = streamingClient(stream);
    const closeHandlers: Array<() => void> = [];
    const res = buildFakeRes({
      req: {
        on: (event, handler) => {
          if (event === 'close') closeHandlers.push(handler);
        },
      },
    });
    await proxyStream(client, '1', res as unknown as Response);
    await new Promise((r) => setImmediate(r));
    expect(closeHandlers).toHaveLength(1);
    // Simulate browser disconnect.
    closeHandlers[0]();
    expect(destroy).toHaveBeenCalled();
  });

  it('handles upstream stream error by ending the response once', async () => {
    const stream = new Readable({
      read() {
        this.emit('error', new Error('upstream blew up'));
      },
    });
    const client = streamingClient(stream);
    const res = buildFakeRes();
    await proxyStream(client, '1', res as unknown as Response);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});

/**
 * Lets a Readable's `data` delivery land without touching the clock.
 *
 * `process.nextTick` is one of the two timers Vitest deliberately does NOT
 * fake (the other is `queueMicrotask`), so it still advances under
 * `vi.useFakeTimers()`. `setImmediate` — which the specs above use — IS
 * faked, so it would hang here.
 */
function flushStream(): Promise<void> {
  return new Promise((resolve) => {
    process.nextTick(resolve);
  });
}

/**
 * An upstream that is connected and will never end, error, or FIN. This is
 * exactly what a partitioned panel looks like from reiwa: the socket is
 * open, `openStream` set `bodyTimeout: 0` so undici will not time it out,
 * and no stream event will ever fire again.
 */
function silentUpstream(): Readable {
  return new Readable({
    read() {
      /* nothing arrives, ever */
    },
  });
}

describe('proxyStream upstream idle watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('ends the subscriber stream when the upstream goes silent without closing', async () => {
    const stream = silentUpstream();
    const res = buildFakeRes();
    await proxyStream(streamingClient(stream), '1', res as unknown as Response);

    // Prove the stream is live first, so the close below can only be the
    // watchdog and not a mis-wired open.
    stream.push(Buffer.from('event: realtime.ready\ndata: {}\n\n'));
    await flushStream();
    expect(res.end).not.toHaveBeenCalled();

    // Then the panel disappears without a FIN/RST.
    await vi.advanceTimersByTimeAsync(UPSTREAM_IDLE_TIMEOUT_MS - 1);
    expect(res.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it('closes even though our own `: ping` is still succeeding', async () => {
    // This is why the bug is invisible without a watchdog: the browser leg
    // stays warm, so `EventSource.readyState` stays OPEN and `onerror` never
    // fires. Our heartbeat must not be mistaken for upstream liveness.
    const stream = silentUpstream();
    const res = buildFakeRes();
    await proxyStream(streamingClient(stream), '1', res as unknown as Response);

    await vi.advanceTimersByTimeAsync(UPSTREAM_IDLE_TIMEOUT_MS);

    const written = res.write.mock.calls.map((c) => String(c[0]));
    expect(written.filter((w) => w === ': ping\n\n').length).toBeGreaterThan(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('names the idle timeout as the close reason', async () => {
    const stream = silentUpstream();
    const res = buildFakeRes();
    await proxyStream(streamingClient(stream), '1', res as unknown as Response);
    await vi.advanceTimersByTimeAsync(UPSTREAM_IDLE_TIMEOUT_MS);

    const written = res.write.mock.calls.map((c) => String(c[0]));
    expect(written).toContain('event: realtime.unavailable\n');
    expect(
      written.some((w) => w.includes('"reason":"upstream_idle_timeout"')),
    ).toBe(true);
  });

  it('destroys the upstream when the watchdog fires', async () => {
    const destroy = vi.fn();
    const stream = Object.assign(silentUpstream(), { destroy });
    const res = buildFakeRes();
    await proxyStream(streamingClient(stream), '1', res as unknown as Response);
    await vi.advanceTimersByTimeAsync(UPSTREAM_IDLE_TIMEOUT_MS);
    expect(destroy).toHaveBeenCalled();
  });

  it('is rearmed by a bare `: keepalive` comment, not only by events', async () => {
    // The panel's liveness signal is a COMMENT line every 25s
    // (internal-user-realtime.controller.ts, HEARTBEAT_INTERVAL_MS). A
    // watchdog that only counted parsed events would tear down every healthy
    // but eventless stream on schedule — a worse bug than the one it guards
    // against. One hour of a perfectly healthy, completely eventless stream:
    const PANEL_KEEPALIVE_MS = 25_000;
    const ONE_HOUR_MS = 60 * 60_000;
    const stream = silentUpstream();
    const res = buildFakeRes();
    await proxyStream(streamingClient(stream), '1', res as unknown as Response);

    for (let elapsed = 0; elapsed < ONE_HOUR_MS; elapsed += PANEL_KEEPALIVE_MS) {
      await vi.advanceTimersByTimeAsync(PANEL_KEEPALIVE_MS);
      stream.push(Buffer.from(': keepalive\n\n'));
      await flushStream();
    }
    expect(res.end).not.toHaveBeenCalled();
    expect(res.writableEnded).toBe(false);

    // ...and it is still armed the whole time: stop the keepalives and it fires.
    await vi.advanceTimersByTimeAsync(UPSTREAM_IDLE_TIMEOUT_MS);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('leaves room for one completely missed keepalive', async () => {
    // The margin is the point of the 60s figure: a single lost keepalive on a
    // link that is merely retransmitting must not look like death.
    const PANEL_KEEPALIVE_MS = 25_000;
    const stream = silentUpstream();
    const res = buildFakeRes();
    await proxyStream(streamingClient(stream), '1', res as unknown as Response);

    // Two keepalives skipped entirely; the third arrives late.
    await vi.advanceTimersByTimeAsync(PANEL_KEEPALIVE_MS * 2 + 5_000);
    expect(res.end).not.toHaveBeenCalled();
    stream.push(Buffer.from(': keepalive\n\n'));
    await flushStream();

    await vi.advanceTimersByTimeAsync(PANEL_KEEPALIVE_MS);
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('proxyStream reconnect pacing', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pins the reconnection time at the head of every stream', async () => {
    const res = buildFakeRes();
    await proxyStream(
      streamingClient(silentUpstream()),
      '1',
      res as unknown as Response,
    );
    expect(String(res.write.mock.calls[0]?.[0])).toBe(
      `retry: ${CLIENT_RETRY_MS}\n\n`,
    );
  });

  it('backs the reconnection time off when the panel is unreachable', async () => {
    // The browser never sees an error on this path — headers were flushed
    // with a 200 before the upstream was opened, so from its side the
    // connection succeeded and then ended. `retry:` is therefore the only
    // thing between a panel outage and every subscriber re-opening ~20 times
    // a minute, each re-open costing a fresh upstream connect.
    const res = buildFakeRes();
    await proxyStream(rejectingClient(), '1', res as unknown as Response);
    const written = res.write.mock.calls.map((c) => String(c[0]));
    expect(written).toContain(`retry: ${CLIENT_BACKOFF_RETRY_MS}\n\n`);
    // The backoff must come after the reset, or the reset would win.
    expect(written.indexOf(`retry: ${CLIENT_RETRY_MS}\n\n`)).toBeLessThan(
      written.indexOf(`retry: ${CLIENT_BACKOFF_RETRY_MS}\n\n`),
    );
  });

  it('sends realtime.unavailable as a typed event with a full event payload', async () => {
    // Typed, because the SPA registers a listener under this exact name and a
    // typed SSE event never reaches the generic `message` handler. Full
    // payload, because that listener hands the frame to a typed observer.
    // INFO + NOTIFICATION is the pair the client's toast logic ignores, so a
    // panel outage cannot toast once per reconnect.
    const res = buildFakeRes();
    await proxyStream(rejectingClient(), '1', res as unknown as Response);
    const written = res.write.mock.calls.map((c) => String(c[0]));
    const dataLine = written.find((w) => w.startsWith('data: ')) ?? '';
    const payload = JSON.parse(dataLine.slice('data: '.length)) as Record<
      string,
      unknown
    >;
    expect(payload.type).toBe('realtime.unavailable');
    expect(payload.severity).toBe('INFO');
    expect(payload.category).toBe('NOTIFICATION');
    expect(payload.metadata).toEqual({ reason: 'upstream_rejected' });
    expect(typeof payload.timestamp).toBe('string');
  });
});
