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
 *   - Upstream success pipes every chunk through to res.write.
 *   - Stream `end` closes the response exactly once.
 *   - Browser `close` event tears down the upstream stream.
 *   - URL-encodes the telegramId path segment.
 */
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
    expect(res.write).toHaveBeenCalledWith('data: {"reason":"upstream_rejected"}\n\n');
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
    // Force writableEnded after the first chunk.
    res.write = vi.fn(() => {
      res.writableEnded = true;
      return true;
    });
    await proxyStream(client, '1', res as unknown as Response);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Only the first chunk lands in res.write.
    expect(res.write).toHaveBeenCalledTimes(1);
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
