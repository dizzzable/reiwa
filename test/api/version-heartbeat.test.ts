/**
 * The version heartbeat at start is asked again until the panel takes it
 * (review R1-05, `src/api/version-heartbeat.ts`).
 *
 * Sent once, a heartbeat lost to a panel that was briefly unreachable left the
 * previous release's record on the panel for up to 65 minutes. Panel 0.9.7.71
 * gates «до сброса» on that record.
 *
 * Pinned here, on fake timers:
 *  - the first heartbeat goes at once and nothing waits for it;
 *  - one the panel did not get is sent again after 5 s, then twice as long each
 *    time, at most 5 min apart, until the first 2xx; then hourly;
 *  - a refusal (a 4xx other than 404, 408 and 429) is said once at warn and
 *    goes hourly, since asking again gets the same answer;
 *  - an hourly heartbeat that fails waits for the next hour, as before;
 *  - `stop()` ends it, including an attempt still in flight.
 */
import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../../src/core/errors/index.js';
import {
  VERSION_HEARTBEAT_TIMEOUT_MS,
  isHeartbeatRefusal,
  startVersionHeartbeat,
  type VersionHeartbeat,
} from '../../src/api/version-heartbeat.js';

const T0 = 1_800_000_000_000;
const SECOND = 1_000;
const HOUR = 3_600 * SECOND;

const upstream = (status: number): UpstreamError =>
  new UpstreamError('POST', '/api/internal/system/reiwa-version', status, `status ${status}`);
const offline = (): Error => new Error('connect ECONNREFUSED 10.0.0.2:3000');

type Outcome = 'ok' | 'hang' | Error;

/** A panel that answers each heartbeat by the script, the last outcome repeating. */
function panel(...outcomes: Outcome[]) {
  const at: number[] = [];
  let index = 0;
  const send = vi.fn((): Promise<unknown> => {
    at.push(Date.now() - T0);
    const outcome = outcomes[Math.min(index, outcomes.length - 1)]!;
    index += 1;
    if (outcome === 'ok') return Promise.resolve({ ok: true });
    if (outcome === 'hang') return new Promise<never>(() => undefined);
    return Promise.reject(outcome);
  });
  /** The waits between heartbeats, in seconds. */
  const gaps = (): number[] => at.slice(1).map((time, i) => (time - at[i]!) / SECOND);
  return { send, at, gaps };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

let running: VersionHeartbeat | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  running?.stop();
  running = null;
  vi.useRealTimers();
});

describe('the heartbeat at start', () => {
  it('goes at once, and the start does not wait for it', () => {
    const { send } = panel('hang');
    running = startVersionHeartbeat({ send });
    // Returned while the panel has not answered; the heartbeat is already out.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is sent again after 5 s, then twice as long each time, at most 5 min apart — until the first 2xx; then hourly', async () => {
    const failures = Array.from({ length: 8 }, offline);
    const { send, gaps } = panel(...failures, 'ok');
    running = startVersionHeartbeat({ send, logger: logger() as never });

    await vi.advanceTimersByTimeAsync(915 * SECOND);
    expect(send).toHaveBeenCalledTimes(9);
    expect(gaps()).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);

    // Taken: the next one is the hourly one, and nothing before it.
    await vi.advanceTimersByTimeAsync(HOUR - SECOND);
    expect(send).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(send).toHaveBeenCalledTimes(10);
    expect(gaps().at(-1)).toBe(3_600);
  });

  it.each([
    ['no answer at all (a connection refused)', offline()],
    ['502', upstream(502)],
    ['503', upstream(503)],
    ['404 (a panel still starting, or the proxy in front of one)', upstream(404)],
    ['408 (the panel’s own request timeout)', upstream(408)],
    ['429', upstream(429)],
  ])('is asked again soon after %s', async (_label, error) => {
    const { send, gaps } = panel(error, 'ok');
    running = startVersionHeartbeat({ send });

    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(send).toHaveBeenCalledTimes(2);
    expect(gaps()).toEqual([5]);
  });

  it('counts an attempt with no answer as failed once the timeout passes, and asks again', async () => {
    const { send, gaps } = panel('hang', 'ok');
    running = startVersionHeartbeat({ send });

    await vi.advanceTimersByTimeAsync(VERSION_HEARTBEAT_TIMEOUT_MS + 5 * SECOND);
    expect(send).toHaveBeenCalledTimes(2);
    expect(gaps()).toEqual([VERSION_HEARTBEAT_TIMEOUT_MS / SECOND + 5]);
  });

  it('says once, at info, that the panel took it late', async () => {
    const log = logger();
    const { send } = panel(offline(), offline(), 'ok');
    running = startVersionHeartbeat({ send, logger: log as never });

    await vi.advanceTimersByTimeAsync(15 * SECOND);
    expect(send).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      { attempts: 3 },
      'reiwa version heartbeat: the panel took it after it failed at start',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('a refusal', () => {
  it.each([400, 401, 403, 413, 422])('%i is said once at warn, and the heartbeat goes hourly', async (status) => {
    const log = logger();
    const { send, gaps } = panel(upstream(status));
    running = startVersionHeartbeat({ send, logger: log as never });

    await vi.advanceTimersByTimeAsync(HOUR - SECOND);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SECOND + HOUR);
    expect(send).toHaveBeenCalledTimes(3);
    expect(gaps()).toEqual([3_600, 3_600]);
    // Refused three times, said once.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ status });
  });

  it('isHeartbeatRefusal: only a 4xx that is not 404, 408 or 429', () => {
    for (const status of [400, 401, 403, 405, 409, 413, 422]) expect(isHeartbeatRefusal(upstream(status)), String(status)).toBe(true);
    for (const status of [404, 408, 429, 500, 502, 503, 504, 302]) expect(isHeartbeatRefusal(upstream(status)), String(status)).toBe(false);
    expect(isHeartbeatRefusal(offline())).toBe(false);
    expect(isHeartbeatRefusal(undefined)).toBe(false);
  });
});

describe('after the panel has taken one', () => {
  it('an hourly heartbeat that fails waits for the next hour, as before', async () => {
    const log = logger();
    const { send, gaps } = panel('ok', offline(), offline(), 'ok');
    running = startVersionHeartbeat({ send, logger: log as never });

    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(send).toHaveBeenCalledTimes(4);
    expect(gaps()).toEqual([3_600, 3_600, 3_600]);
    expect(log.debug.mock.calls.map(([, message]) => message)).toEqual([
      'reiwa version heartbeat failed',
      'reiwa version heartbeat failed',
    ]);
  });
});

describe('stop()', () => {
  it('ends the retries: nothing is sent after a shutdown', async () => {
    const { send } = panel(offline());
    running = startVersionHeartbeat({ send });

    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(send).toHaveBeenCalledTimes(2);
    running.stop();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('an attempt still in flight at the shutdown schedules nothing when it lands, and says nothing', async () => {
    const log = logger();
    let fail: (err: Error) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    );
    running = startVersionHeartbeat({ send, logger: log as never });
    running.stop();

    fail(offline());
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});

/**
 * `src/api/main.ts` sends it this way, and stops it on shutdown. Read through
 * the TypeScript parser, as `test/bot/main-config-wiring.test.ts` reads the
 * bot's main: the main starts a server when imported.
 */
describe('src/api/main.ts', () => {
  const main = ts.createSourceFile(
    'main.ts',
    readFileSync(new URL('../../src/api/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(main);
  const text = (node: ts.Node): string => node.getText(main).replace(/\s+/g, ' ');

  it('starts the heartbeat with the running version, once', () => {
    const starts = nodes
      .filter(ts.isCallExpression)
      .filter((call) => call.expression.getText(main) === 'startVersionHeartbeat');
    expect(starts).toHaveLength(1);
    expect(text(starts[0]!.arguments[0]!)).toBe(
      '{ send: () => adminClient.system.reportReiwaVersion(REIWA_VERSION), logger, }',
    );
    // The old one-shot and its interval are gone: one heartbeat loop, not two.
    const reports = nodes.filter(
      (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'reportReiwaVersion',
    );
    expect(reports).toHaveLength(1);
  });

  it('stops it on shutdown, before anything is closed', () => {
    const shutdown = nodes
      .filter(ts.isVariableDeclaration)
      .find((declaration) => declaration.name.getText(main) === 'shutdown')?.initializer;
    expect(shutdown).toBeDefined();
    const body = text(shutdown!);
    expect(body).toContain('versionHeartbeat?.stop();');
    expect(body.indexOf('versionHeartbeat?.stop();')).toBeLessThan(body.indexOf('adminClient.close()'));
  });
});
