/**
 * An open realtime stream ends with its session.
 *
 * The session check runs on requests, and a stream is one request that stays
 * open: opened before «Выйти на всех устройствах» or a password change
 * elsewhere, it kept delivering to a session that no longer existed. Now:
 *
 *   - the proxy asks, at most once a minute and one question at a time,
 *     whether the session it was opened with is still good, and ends the
 *     stream when it is not; a question that fails keeps the stream — the next
 *     one decides, as the session check lets a request through when the panel
 *     cannot tell;
 *   - the question is the session middleware's own (`revalidateWebSession`):
 *     `false` once the session is gone from Redis, or once the panel says it
 *     was signed out — asked at most once an interval, recorded WITHOUT sliding
 *     the session's 30-day window, so a tab left open does not keep it alive.
 *
 * The proxy runs on fake timers against a real upstream stream; the middleware
 * is the shipped one over a Redis that is a `Map`.
 */
import { PassThrough } from 'node:stream';

import cookieParser from 'cookie-parser';
import express from 'express';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_WATCH_INTERVAL_MS, proxyStream, type OpenStreamFn } from '../../src/api/routes/realtime-proxy.js';
import {
  SESSION_REVOCATION_CHECK_INTERVAL_MS,
  WebSessionStore,
  createWebSessionMiddleware,
  type SessionRevocationCheck,
  type WebSession,
} from '../../src/infrastructure/redis/session.js';
import { sendSocketless } from './socketless-request.js';

// ── The proxy ───────────────────────────────────────────────────────────────

/** The panel's liveness comment frame. */
const KEEPALIVE = [': keepalive', '', ''].join(String.fromCharCode(10));

interface FakeResponse {
  readonly writes: unknown[];
  ended: boolean;
  readonly response: Response;
}

/** The parts of an Express response `proxyStream` touches, recording what it wrote. */
function fakeResponse(): FakeResponse {
  const state: FakeResponse = {
    writes: [],
    ended: false,
    response: undefined as unknown as Response,
  };
  const response = {
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: unknown) => {
      state.writes.push(chunk);
      return true;
    },
    end: () => {
      state.ended = true;
    },
    get writableEnded() {
      return state.ended;
    },
  };
  return Object.assign(state, { response: response as unknown as Response });
}

async function openStream(stillValid: () => Promise<boolean>) {
  const upstream = new PassThrough();
  const client: OpenStreamFn = { openStream: async () => ({ status: 200, body: upstream }) };
  const res = fakeResponse();
  await proxyStream(client, 'user-a', res.response, undefined, { stillValid });
  /**
   * Time passing on a HEALTHY link: the panel's keepalive every 20 s, as it
   * sends one every 25 s, so the idle watchdog never mistakes the quiet for a
   * dead upstream and ends the stream for its own reason.
   */
  const advance = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 20_000) {
      if (!upstream.destroyed) upstream.write(KEEPALIVE);
      await vi.advanceTimersByTimeAsync(Math.min(20_000, left));
    }
  };
  return { upstream, res, advance };
}

describe('the proxy ends a stream whose session is no longer good', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the stream while the session is good, and ends it at the next minute once it is not', async () => {
    let valid = true;
    let asked = 0;
    const { upstream, res, advance } = await openStream(async () => {
      asked += 1;
      return valid;
    });

    await advance(SESSION_WATCH_INTERVAL_MS);
    expect(asked).toBe(1);
    expect(res.ended, 'a good session lost its stream').toBe(false);

    valid = false;
    await advance(SESSION_WATCH_INTERVAL_MS);
    expect(asked).toBe(2);
    expect(res.ended, 'the stream outlived its session').toBe(true);
    expect(upstream.destroyed, 'the upstream was left open behind the ended stream').toBe(true);

    await advance(5 * SESSION_WATCH_INTERVAL_MS);
    expect(asked, 'an ended stream kept asking').toBe(2);
  });

  it('asks at most once a minute, one question at a time', async () => {
    let asked = 0;
    let answer!: (valid: boolean) => void;
    const { res, advance } = await openStream(() => {
      asked += 1;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });

    await advance(SESSION_WATCH_INTERVAL_MS - 1);
    expect(asked, 'asked before the first minute was up').toBe(0);
    await advance(1);
    expect(asked).toBe(1);
    await advance(3 * SESSION_WATCH_INTERVAL_MS);
    expect(asked, 'a second question went out while the first was unanswered').toBe(1);

    answer(true);
    await advance(SESSION_WATCH_INTERVAL_MS);
    expect(asked).toBe(2);
    expect(res.ended).toBe(false);
  });

  it('keeps the stream when the question fails — the next one decides', async () => {
    let asked = 0;
    const { res, advance } = await openStream(async () => {
      asked += 1;
      if (asked === 1) throw new Error('redis is down');
      return false;
    });

    await advance(SESSION_WATCH_INTERVAL_MS);
    expect(res.ended, 'a failed question ended the stream').toBe(false);
    await advance(SESSION_WATCH_INTERVAL_MS);
    expect(res.ended).toBe(true);
  });
});

// ── The question the proxy asks ─────────────────────────────────────────────

/** The shipped store over a Map, recording the arguments of every `set`. */
function liveStore() {
  const rows = new Map<string, string>();
  const sets: unknown[][] = [];
  const redis = {
    async set(key: string, value: string, ...rest: unknown[]): Promise<'OK'> {
      sets.push([key, ...rest]);
      rows.set(key, value);
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      return rows.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return rows.delete(key) ? 1 : 0;
    },
  };
  const store = Object.create(WebSessionStore.prototype) as WebSessionStore;
  (store as unknown as { redis: unknown }).redis = redis;
  const keyOf = (sessionId: string) => [...rows.keys()].find((key) => key.endsWith(sessionId));
  return {
    store,
    sets,
    read: (sessionId: string): WebSession | null => {
      const key = keyOf(sessionId);
      return key === undefined ? null : (JSON.parse(rows.get(key)!) as WebSession);
    },
    patch(sessionId: string, fields: Partial<WebSession>): void {
      const key = keyOf(sessionId)!;
      rows.set(key, JSON.stringify({ ...JSON.parse(rows.get(key)!), ...fields }));
    },
  };
}

/**
 * A cabinet whose one route stands in for a stream: it lets the case change
 * the world while "the stream is open", then asks the question the proxy asks.
 */
function streamingCabinet(store: WebSessionStore, revocation: SessionRevocationCheck, whileOpen: () => Promise<void>) {
  const app = express();
  app.use(cookieParser());
  app.use(createWebSessionMiddleware(store, { redisUrl: '', cookieSecure: false, isProduction: false }, undefined, { revocation }));
  app.get('/api/v1/stream', async (req, res) => {
    await whileOpen();
    res.json({ valid: await req.revalidateWebSession() });
  });
  return app;
}

function openAndAsk(app: express.Express, sessionId: string) {
  return sendSocketless(app, { method: 'GET', url: '/api/v1/stream', headers: { cookie: `reiwa_web_session=${sessionId}` } });
}

describe('the question: is the session a stream was opened with still good', () => {
  it('is no longer good once the session is gone from Redis — signed out here, or ended by another request’s check', async () => {
    const live = liveStore();
    const sessionId = await live.store.create({ userId: 'user-a' }, '127.0.0.1');
    const app = streamingCabinet(live.store, async () => ({ revokedAt: null }), () => live.store.destroy(sessionId));

    expect((await openAndAsk(app, sessionId)).body).toEqual({ valid: false });
  });

  it('is no longer good once the panel says it was signed out — asked when its minute is up, and ended for good', async () => {
    const live = liveStore();
    const sessionId = await live.store.create({ userId: 'user-a' }, '127.0.0.1');
    let asked = 0;
    const revocation: SessionRevocationCheck = async () => {
      asked += 1;
      return { revokedAt: Date.now() + 1_000, panelOffsetMs: 0 };
    };
    // The stream was opened a while ago; its session was asked about at the start.
    const app = streamingCabinet(live.store, revocation, async () => {
      live.patch(sessionId, { revocationCheckedAt: Date.now() - SESSION_REVOCATION_CHECK_INTERVAL_MS - 1 });
    });

    expect((await openAndAsk(app, sessionId)).body).toEqual({ valid: false });
    expect(asked).toBe(1);
    expect(live.read(sessionId), 'the signed-out session stayed in Redis').toBeNull();
  });

  it('stays good between questions without asking the panel, and records a question without sliding the 30-day window', async () => {
    const live = liveStore();
    const sessionId = await live.store.create({ userId: 'user-a' }, '127.0.0.1');
    let asked = 0;
    const revocation: SessionRevocationCheck = async () => {
      asked += 1;
      return { revokedAt: null, panelOffsetMs: 0 };
    };
    live.patch(sessionId, { revocationCheckedAt: Date.now() });
    const within = streamingCabinet(live.store, revocation, async () => undefined);
    expect((await openAndAsk(within, sessionId)).body).toEqual({ valid: true });
    expect(asked, 'asked inside the minute').toBe(0);

    const due = streamingCabinet(live.store, revocation, async () => {
      live.patch(sessionId, { revocationCheckedAt: 0 });
      live.sets.length = 0;
    });
    const before = Date.now();
    expect((await openAndAsk(due, sessionId)).body).toEqual({ valid: true });
    expect(asked).toBe(1);
    expect(live.read(sessionId)!.revocationCheckedAt).toBeGreaterThanOrEqual(before);
    const recorded = live.sets.filter(([key]) => String(key).endsWith(sessionId));
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.at(-1), 'the question slid the session window').toEqual([recorded.at(-1)![0], 'KEEPTTL']);
  });
});
