import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../../../src/core/errors/index.js';
import {
  ConfigVersionPoller,
  type ConfigVersionsReport,
  type VersionedGroup,
} from '../../../src/infrastructure/config-versions/poller.js';
import type { ConfigVersionKey } from '../../../src/infrastructure/config-versions/config-version.js';

/**
 * The version poll — the safety net under the panel's settings webhook.
 *
 * Pinned here: it re-reads exactly the groups whose held copy is older than the
 * panel's, it tells the panel what it holds, and a panel that fails never costs
 * more than one warning and a growing wait.
 */

const V1 = '1'.repeat(32);
const V2 = '2'.repeat(32);

function group(key: ConfigVersionKey, held: string | null) {
  const state = { held };
  const reset = vi.fn();
  const reload = vi.fn(async () => undefined);
  const versioned: VersionedGroup = { key, held: () => state.held, reset, reload };
  return { versioned, reset, reload, state };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('what a poll re-reads', () => {
  it('re-reads only the groups whose held copy is not the panel’s version — through the reset, then the read', async () => {
    const behind = group('publicConfig', V1);
    const current = group('landing', V2);
    const nothingHeld = group('connectPage', null);
    const unknownToPanel = group('guestSupport', V1);
    const poll = vi.fn(async () => ({
      versions: { publicConfig: V2, landing: V2, connectPage: V2 },
    }));
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [behind.versioned, current.versioned, nothingHeld.versioned, unknownToPanel.versioned],
      poll,
    });

    await poller.tick();

    expect(behind.reset).toHaveBeenCalledTimes(1);
    expect(behind.reload).toHaveBeenCalledTimes(1);
    expect(behind.reset.mock.invocationCallOrder[0]).toBeLessThan(behind.reload.mock.invocationCallOrder[0] as number);
    // Up to date; holding nothing (the next read asks anyway); a key the panel
    // does not version (an older panel): none of them is touched.
    for (const untouched of [current, nothingHeld, unknownToPanel]) {
      expect(untouched.reset).not.toHaveBeenCalled();
      expect(untouched.reload).not.toHaveBeenCalled();
    }
  });

  it('tells the panel what this process holds — the report the delivery check reads', async () => {
    const reports: ConfigVersionsReport[] = [];
    const poller = new ConfigVersionPoller({
      consumer: 'bot',
      groups: [group('botConfig', V1).versioned, group('platformPolicy', null).versioned],
      poll: async (report) => {
        reports.push(report);
        return { versions: {} };
      },
    });

    await poller.tick();

    expect(reports).toEqual([{ consumer: 'bot', held: { botConfig: V1, platformPolicy: null } }]);
  });

  it('re-reads a group for one panel version once per retry window, and at once for a newer one', async () => {
    // A copy the cabinet keeps refusing (a theme value its guard rejects) must
    // not cost a panel read on every poll.
    vi.useFakeTimers();
    const behind = group('publicConfig', V1);
    let panel = V2;
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [behind.versioned],
      poll: async () => ({ versions: { publicConfig: panel } }),
      retryRefreshAfterMs: 60_000,
    });

    await poller.tick();
    await poller.tick();
    expect(behind.reload).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await poller.tick();
    expect(behind.reload).toHaveBeenCalledTimes(2);

    panel = '3'.repeat(32);
    await poller.tick();
    expect(behind.reload).toHaveBeenCalledTimes(3);
  });

  it('keeps polling when a re-read throws or rejects', async () => {
    const log = logger();
    const throwing: VersionedGroup = {
      key: 'landing',
      held: () => V1,
      reset: () => {
        throw new Error('reset blew up');
      },
      reload: vi.fn(),
    };
    const rejecting: VersionedGroup = {
      key: 'publicConfig',
      held: () => V1,
      reset: vi.fn(),
      reload: async () => {
        throw new Error('panel read failed');
      },
    };
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [throwing, rejecting],
      poll: async () => ({ versions: { landing: V2, publicConfig: V2 } }),
      logger: log as never,
    });

    // Re-reads were made (and failed): the next poll follows at once to report.
    await expect(poller.tick()).resolves.toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

/**
 * The report the panel keeps is what the process holds AFTER the re-reads a
 * poll started (review R2a-04). A poll's own report is taken before them: the
 * first poll after a blip, 105 s after a save, reported the old version, the
 * re-read landed at 106 s, and the panel's check at 120 s read a 15-second-old
 * report of the old version — a «не принял» card about a change that had
 * arrived. The next report came only 20 s later.
 */
describe('the report after a re-read (review R2a-04)', () => {
  it('follows at once, when the re-read has landed, and reports the new version', async () => {
    const behind = group('publicConfig', V1);
    // The re-read lands a moment later; the copy is then the panel's version.
    behind.reload.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            behind.state.held = V2;
            resolve(undefined);
          }, 30);
        }),
    );
    const reports: ConfigVersionsReport[] = [];
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [behind.versioned],
      poll: async (report) => {
        reports.push(report);
        return { versions: { publicConfig: V2 } };
      },
      intervalMs: 20_000,
    });

    expect(await poller.tick()).toBe(0);
    // Not before the re-read has landed: the follow-up's report would be the old one.
    expect(behind.state.held).toBe(V2);

    // The follow-up: the new version reported, nothing re-read, the usual wait.
    expect(await poller.tick()).toBe(20_000);
    expect(reports.map((report) => report.held['publicConfig'])).toEqual([V1, V2]);
    expect(behind.reload).toHaveBeenCalledTimes(1);
  });

  it('waits for a re-read that hangs no longer than a poll’s timeout, then reports what is held', async () => {
    vi.useFakeTimers();
    const behind = group('publicConfig', V1);
    behind.reload.mockImplementation(() => new Promise<undefined>(() => undefined));
    behind.reset.mockImplementation(() => {
      behind.state.held = null;
    });
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [behind.versioned],
      poll: async () => ({ versions: { publicConfig: V2 } }),
      timeoutMs: 8_000,
    });

    const first = poller.tick();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await first).toBe(0);
  });

  it('a poll that re-read nothing keeps the usual wait', async () => {
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [group('publicConfig', V2).versioned],
      poll: async () => ({ versions: { publicConfig: V2 } }),
      intervalMs: 20_000,
    });
    expect(await poller.tick()).toBe(20_000);
  });
});

describe('a poll that fails', () => {
  it('warns once, backs off twice as long each time up to the ceiling, and says once when the panel is back', async () => {
    const log = logger();
    let failing = true;
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [],
      poll: async () => {
        if (failing) throw new Error('connect ECONNREFUSED');
        return { versions: {} };
      },
      logger: log as never,
      intervalMs: 20_000,
      maxBackoffMs: 300_000,
    });

    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) waits.push(await poller.tick());

    expect(waits).toEqual([40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(5);

    failing = false;
    expect(await poller.tick()).toBe(20_000);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(await poller.tick()).toBe(20_000);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('takes a panel without the route (404) as "not supported": said once, asked only at the ceiling', async () => {
    const log = logger();
    const poller = new ConfigVersionPoller({
      consumer: 'bot',
      groups: [],
      poll: async () => {
        throw new UpstreamError('POST', '/api/internal/config-versions', 404, 'Cannot POST');
      },
      logger: log as never,
      maxBackoffMs: 300_000,
    });

    expect(await poller.tick()).toBe(300_000);
    expect(await poller.tick()).toBe(300_000);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('gives up on a poll that never answers, as a failure', async () => {
    vi.useFakeTimers();
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [],
      poll: () => new Promise<never>(() => undefined),
      timeoutMs: 8_000,
      intervalMs: 20_000,
    });

    const wait = poller.tick();
    vi.advanceTimersByTime(8_000);
    expect(await wait).toBe(40_000);
  });

  it('counts an answer without versions as a failure, not as "nothing changed"', async () => {
    const behind = group('publicConfig', V1);
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [behind.versioned],
      poll: async () => ({ message: 'Internal server error' }),
      intervalMs: 20_000,
    });
    expect(await poller.tick()).toBe(40_000);
    expect(behind.reload).not.toHaveBeenCalled();
  });
});

describe('the poll loop', () => {
  it('polls on its own timer until stopped, never two at a time', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const poll = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      inFlight -= 1;
      return { versions: {} };
    });
    const poller = new ConfigVersionPoller({ consumer: 'api', groups: [], poll, intervalMs: 20_000, jitterMs: 0, timeoutMs: 60_000 });

    poller.start(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(1);
    // The next poll is scheduled after this one answers, not beside it.
    await vi.advanceTimersByTimeAsync(30_000 + 20_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

/**
 * What an answered poll leaves behind: the panel's versions, with the time the
 * answer came, for reiwa's key of latest versions (`latest.ts`) — which the bot
 * compares its copy with on every press.
 */
describe('what a poll tells the key of latest versions', () => {
  it('every version the panel answered, and when — before it re-reads anything', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const order: string[] = [];
    const behind = group('publicConfig', V1);
    behind.reset.mockImplementation(() => order.push('reset'));
    const onVersions = vi.fn((_versions: Readonly<Record<string, string>>, _at: number) => {
      order.push('onVersions');
    });
    const poller = new ConfigVersionPoller({
      consumer: 'bot',
      groups: [behind.versioned],
      poll: async () => ({ versions: { publicConfig: V2, botConfig: V1, 'legalDocuments.ru': V2, landing: '' } }),
      onVersions,
    });

    await poller.tick();

    // Every group the panel versions — not only the ones this process holds —
    // and nothing the panel did not give a version for.
    expect(onVersions).toHaveBeenCalledExactlyOnceWith(
      { publicConfig: V2, botConfig: V1, 'legalDocuments.ru': V2 },
      1_800_000_000_000,
    );
    expect(order).toEqual(['onVersions', 'reset']);
  });

  it('nothing when the poll fails or answers without versions', async () => {
    const onVersions = vi.fn();
    const failing = new ConfigVersionPoller({
      consumer: 'api',
      groups: [],
      poll: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      onVersions,
    });
    const empty = new ConfigVersionPoller({ consumer: 'api', groups: [], poll: async () => ({ message: 'nope' }), onVersions });

    await failing.tick();
    await empty.tick();
    expect(onVersions).not.toHaveBeenCalled();
  });

  it('a listener that throws costs a debug line, not the poll', async () => {
    const log = logger();
    const behind = group('landing', V1);
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [behind.versioned],
      poll: async () => ({ versions: { landing: V2 } }),
      onVersions: () => {
        throw new Error('redis gone');
      },
      logger: log as never,
    });

    // It re-read the group: the report after it follows at once.
    expect(await poller.tick()).toBe(0);
    expect(behind.reload).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(1);
  });
});
