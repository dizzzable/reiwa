import { describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../../../src/core/errors/index.js';
import {
  NOOP_PANEL_CAPABILITIES,
  PANEL_LEGACY_NO_BLOCK,
  PANEL_LEGACY_NO_ROUTE,
  RedisPanelCapabilities,
  panelCan,
  panelOf,
  panelRecorder,
  type PanelView,
} from '../../../src/infrastructure/config-versions/panel-capabilities.js';
import { ConfigVersionPoller } from '../../../src/infrastructure/config-versions/poller.js';
import { panelCapabilitiesKey } from '../../../src/infrastructure/redis/keys.js';

/**
 * What the panel says about itself in the version poll's answer, and what the
 * cabinet keeps of it (pair design D1 §6.6).
 *
 * Pinned here:
 *  - only `panel.*` ids in the shared format are taken from the answer;
 *  - an answer WITHOUT the block, and a 404 on the poll, are kept as "legacy"
 *    OVER whatever was kept, so a panel rolled back to an older release never
 *    keeps the capabilities of the newer one;
 *  - a poll that fails any other way changes nothing;
 *  - Redis trouble is "nothing known", and nothing known is "no".
 */

/** A Redis string store in memory: SET replaces, GET answers what is there. */
function fakeRedis() {
  const values = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      values.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
  };
  return { redis, values };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

const V = '1'.repeat(32);

describe('panelOf — what an answered poll says about the panel', () => {
  it('takes the version and the panel.* ids, and drops everything else in the list', () => {
    const view = panelOf({
      versions: { publicConfig: V },
      panel: {
        version: '0.9.7.71',
        capabilities: [
          'panel.cabinet-peers',
          'panel.cabinet-peers', // a repeat
          'web.addon-reset-end', // not the panel's area
          'panel.Upper', // not the format
          42,
          'panel.' + 'x'.repeat(60), // too long
          'panel.addon-reset.v2',
        ],
      },
    });
    expect(view).toEqual({
      kind: 'declared',
      version: '0.9.7.71',
      capabilities: ['panel.cabinet-peers', 'panel.addon-reset.v2'],
    });
  });

  it('a block that says nothing useful is still a block: declared, with nothing in it', () => {
    expect(panelOf({ versions: {}, panel: {} })).toEqual({ kind: 'declared', version: null, capabilities: [] });
    expect(panelOf({ versions: {}, panel: { version: 'latest\n', capabilities: 'panel.x' } })).toEqual({
      kind: 'declared',
      version: null,
      capabilities: [],
    });
  });

  it('keeps at most 64 ids from one answer', () => {
    const many = Array.from({ length: 100 }, (_, index) => `panel.c${index}`);
    const view = panelOf({ versions: {}, panel: { version: '0.9.7.71', capabilities: many } });
    expect(view.kind === 'declared' && view.capabilities).toEqual(many.slice(0, 64));
  });

  it('an answer without the block — a panel 0.9.7.70 or older — is legacy', () => {
    expect(panelOf({ versions: { publicConfig: V } })).toBe(PANEL_LEGACY_NO_BLOCK);
    expect(panelOf({ versions: {}, panel: null })).toBe(PANEL_LEGACY_NO_BLOCK);
    expect(panelOf({ versions: {}, panel: ['panel.x'] })).toBe(PANEL_LEGACY_NO_BLOCK);
    expect(panelOf({ versions: {}, panel: 'panel.x' })).toBe(PANEL_LEGACY_NO_BLOCK);
    expect(panelOf(null)).toBe(PANEL_LEGACY_NO_BLOCK);
  });
});

describe('RedisPanelCapabilities — what is kept', () => {
  it('keeps a declared panel under its key, with no expiry, and answers can() from it', async () => {
    const { redis, values } = fakeRedis();
    const store = new RedisPanelCapabilities({ redis: redis as never });

    await store.record({ kind: 'declared', version: '0.9.7.71', capabilities: ['panel.cabinet-peers'] }, 1_000);

    expect(panelCapabilitiesKey()).toBe('reiwa:panel-capabilities:v1');
    expect([...values.keys()]).toEqual([panelCapabilitiesKey()]);
    // A plain SET of the key and the value, nothing after: no EX, no PX, no KEEPTTL.
    expect(redis.set.mock.calls[0]).toHaveLength(2);
    expect(JSON.parse(values.get(panelCapabilitiesKey())!)).toEqual({
      kind: 'declared',
      version: '0.9.7.71',
      capabilities: ['panel.cabinet-peers'],
      at: 1_000,
    });
    expect(await store.read()).toEqual({
      kind: 'declared',
      version: '0.9.7.71',
      capabilities: ['panel.cabinet-peers'],
      at: 1_000,
    });
    expect(await store.can('panel.cabinet-peers')).toBe(true);
    expect(await store.can('panel.something-else')).toBe(false);
  });

  it('legacy is kept OVER a declared panel: a rolled-back panel keeps nothing of the newer one', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPanelCapabilities({ redis: redis as never });
    await store.record({ kind: 'declared', version: '0.9.7.71', capabilities: ['panel.cabinet-peers'] }, 1_000);

    await store.record(PANEL_LEGACY_NO_BLOCK, 2_000);

    expect(await store.read()).toEqual({ kind: 'legacy', version: null, capabilities: [], at: 2_000 });
    expect(await store.can('panel.cabinet-peers')).toBe(false);
  });

  it('what does not parse is not known — and not known is "no"', async () => {
    const { redis, values } = fakeRedis();
    const store = new RedisPanelCapabilities({ redis: redis as never });
    const key = panelCapabilitiesKey();

    for (const junk of [
      'not json',
      '"a string"',
      JSON.stringify({ kind: 'declared', version: '0.9.7.71', capabilities: ['panel.x'] }), // no time
      JSON.stringify({ kind: 'maybe', version: null, capabilities: [], at: 1 }),
      JSON.stringify({ kind: 'declared', version: 'latest', capabilities: ['panel.x'], at: 1 }),
    ]) {
      values.set(key, junk);
      expect(await store.read(), junk).toBeNull();
      expect(await store.can('panel.x'), junk).toBe(false);
    }
    // A legacy value never carries capabilities, whatever was written beside it.
    values.set(key, JSON.stringify({ kind: 'legacy', version: '0.9.7.71', capabilities: ['panel.x'], at: 5 }));
    expect(await store.read()).toEqual({ kind: 'legacy', version: null, capabilities: [], at: 5 });
    expect(await store.can('panel.x')).toBe(false);
  });

  it('nothing kept yet is "no"', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPanelCapabilities({ redis: redis as never });
    expect(await store.read()).toBeNull();
    expect(await store.can('panel.x')).toBe(false);
  });

  it('Redis trouble is never a throw: a failed write is a warning, a failed read is "no"', async () => {
    const log = logger();
    const redis = {
      set: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const store = new RedisPanelCapabilities({ redis: redis as never, logger: log as never });

    await expect(store.record(PANEL_LEGACY_NO_ROUTE, 1_000)).resolves.toBeUndefined();
    await expect(store.read()).resolves.toBeNull();
    await expect(store.can('panel.x')).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('without Redis nothing is kept, and the panel can do nothing new', async () => {
    await NOOP_PANEL_CAPABILITIES.record({ kind: 'declared', version: '0.9.7.71', capabilities: ['panel.x'] }, 1);
    expect(await NOOP_PANEL_CAPABILITIES.read()).toBeNull();
    expect(await NOOP_PANEL_CAPABILITIES.can('panel.x')).toBe(false);
  });

  it('panelCan answers from a kept value alone', () => {
    const declared = { kind: 'declared', version: '0.9.7.71', capabilities: ['panel.x'], at: 1 } as const;
    expect(panelCan(declared, 'panel.x')).toBe(true);
    expect(panelCan(declared, 'panel.y')).toBe(false);
    expect(panelCan({ kind: 'legacy', version: null, capabilities: ['panel.x'], at: 1 }, 'panel.x')).toBe(false);
    expect(panelCan(null, 'panel.x')).toBe(false);
  });
});

describe('panelRecorder — the poll’s onPanel for one process', () => {
  it('keeps every view it hears, and logs a change once, not every poll', async () => {
    const log = logger();
    const record = vi.fn(async (_panel: PanelView, _at: number) => undefined);
    const onPanel = panelRecorder({ ...NOOP_PANEL_CAPABILITIES, record }, { consumer: 'api', logger: log as never });
    const declared: PanelView = { kind: 'declared', version: '0.9.7.71', capabilities: ['panel.x'] };

    onPanel(PANEL_LEGACY_NO_BLOCK, 1);
    onPanel(PANEL_LEGACY_NO_BLOCK, 2);
    onPanel(declared, 3);
    onPanel({ kind: 'declared', version: '0.9.7.71', capabilities: ['panel.x'] }, 4);
    onPanel(PANEL_LEGACY_NO_ROUTE, 5);

    expect(record.mock.calls.map(([, at]) => at)).toEqual([1, 2, 3, 4, 5]);
    expect(log.info.mock.calls.map(([, message]) => message)).toEqual([
      'panel capabilities: the panel does not say what it can do (a panel older than 0.9.7.71); kept as legacy',
      'panel capabilities: the panel says what it can do',
      'panel capabilities: the panel has no version poll (a panel older than 0.9.7.70); kept as legacy',
    ]);
    expect(log.info.mock.calls[1]![0]).toEqual({
      consumer: 'api',
      panelVersion: '0.9.7.71',
      capabilities: ['panel.x'],
    });
  });
});

/**
 * The poll, the recorder and the store together — the path `api/main.ts` and
 * `bot/main.ts` wire. This is where "legacy overwrites" is decided.
 */
describe('what the poll leaves in Redis', () => {
  function wired(answers: Array<() => unknown>) {
    const { redis } = fakeRedis();
    const store = new RedisPanelCapabilities({ redis: redis as never });
    let next = 0;
    const poller = new ConfigVersionPoller({
      consumer: 'api',
      groups: [],
      poll: async () => answers[Math.min(next++, answers.length - 1)]!(),
      onPanel: panelRecorder(store, { consumer: 'api' }),
    });
    return { poller, store };
  }

  const NEW_PANEL = () => ({
    versions: { publicConfig: V },
    panel: { version: '0.9.7.71', capabilities: ['panel.cabinet-peers'] },
  });
  const PANEL_0_9_7_70 = () => ({ versions: { publicConfig: V } });
  const PANEL_0_9_7_69 = () => {
    throw new UpstreamError('POST', '/api/internal/config-versions', 404, 'Cannot POST');
  };

  it('a new panel is kept as declared', async () => {
    const { poller, store } = wired([NEW_PANEL]);
    await poller.tick();
    expect(await store.read()).toMatchObject({ kind: 'declared', version: '0.9.7.71', capabilities: ['panel.cabinet-peers'] });
    expect(await store.can('panel.cabinet-peers')).toBe(true);
  });

  it('rolled back to 0.9.7.70 — an answer without the block — overwrites it with legacy', async () => {
    const { poller, store } = wired([NEW_PANEL, PANEL_0_9_7_70]);
    await poller.tick();
    await poller.tick();
    expect(await store.read()).toMatchObject({ kind: 'legacy', capabilities: [] });
    expect(await store.can('panel.cabinet-peers')).toBe(false);
  });

  it('rolled back past the poll (0.9.7.69) — a 404 — overwrites it with legacy', async () => {
    const { poller, store } = wired([NEW_PANEL, PANEL_0_9_7_69]);
    await poller.tick();
    await poller.tick();
    expect(await store.read()).toMatchObject({ kind: 'legacy', capabilities: [] });
    expect(await store.can('panel.cabinet-peers')).toBe(false);
  });

  it('a poll that fails any other way leaves what was kept', async () => {
    const failures: Array<() => unknown> = [
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      () => {
        throw new UpstreamError('POST', '/api/internal/config-versions', 503, 'Service Unavailable');
      },
      () => ({ message: 'Internal server error' }), // no versions: counted as a failure
    ];
    const { poller, store } = wired([NEW_PANEL, ...failures]);
    for (let poll = 0; poll < 1 + failures.length; poll += 1) await poller.tick();
    expect(await store.can('panel.cabinet-peers')).toBe(true);
  });
});
