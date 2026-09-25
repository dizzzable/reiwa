import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicConfigSnapshot } from '../../../src/application/ports/public-config-persistence.port.js';
import {
  getPublicConfigPayload,
  heldPublicConfigVersion,
  resetBrandingCache,
} from '../../../src/api/routes/branding.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import { RedisLastKnownGoodStore } from '../../../src/infrastructure/config-versions/last-known-good.js';
import { RedisPublicConfigPersistence } from '../../../src/infrastructure/public-config/redis-public-config-persistence.js';
import { createPublicConfigRejectionNotifier } from '../../../src/infrastructure/public-config/rejection-notifier.js';

/**
 * The public config's saved copy, moved into the shared last-known-good store
 * (W8 report D11): the old unversioned key read once and retired, and every
 * rejection still reported with the key it failed on.
 */

const SNAPSHOT: PublicConfigSnapshot = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: null,
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
    cardLogo: 'DEFAULT',
    cardLogoUrl: null,
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 0.7,
    cardEffectsByIndex: [],
    bgEffect: 'AURORA',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
};

function fakeRedis(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const redis = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...options: string[]) => {
      if (options.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
  return { data, redis };
}

function notifier() {
  return { rejected: vi.fn(), accepted: vi.fn() };
}

function persistence(redis: ReturnType<typeof fakeRedis>['redis'], note = notifier()) {
  return new RedisPublicConfigPersistence({
    redis: redis as never,
    rejectionNotifier: note as never,
    store: new RedisLastKnownGoodStore({ redis: redis as never }),
  });
}

describe('RedisPublicConfigPersistence on the shared store', () => {
  it('serves the copy kept under the old key once, and the first save retires it', async () => {
    const { data, redis } = fakeRedis({ 'reiwa:public-config:last-known-good': JSON.stringify(SNAPSHOT) });
    const store = persistence(redis);

    expect(await store.load()).toEqual(SNAPSHOT);
    expect(JSON.parse(data.get('reiwa:lkg:public-config:v1') as string).payload).toEqual(SNAPSHOT);

    await store.save({ ...SNAPSHOT, defaultCurrency: 'RUB' });
    expect(data.has('reiwa:public-config:last-known-good')).toBe(false);
    expect(await store.load()).toEqual({ ...SNAPSHOT, defaultCurrency: 'RUB' });
  });

  it('reports a stored copy the guard rejects, naming the key, and serves nothing', async () => {
    const broken = { ...SNAPSHOT, branding: { ...SNAPSHOT.branding, bgEffect: 'LAVA' } };
    const { redis } = fakeRedis({
      'reiwa:lkg:public-config:v1': JSON.stringify({ shape: 1, savedAt: 1, hash: 'h', payload: broken }),
    });
    const note = notifier();

    expect(await persistence(redis, note).load()).toBeNull();
    expect(note.rejected).toHaveBeenCalledWith('redis-load', expect.objectContaining({ key: 'branding.bgEffect' }));
  });

  it('does not save a snapshot the guard rejects', async () => {
    const { data, redis } = fakeRedis();
    const note = notifier();
    await persistence(redis, note).save({ ...SNAPSHOT, locales: 'en' } as never);
    expect(data.size).toBe(0);
    expect(note.rejected).toHaveBeenCalledWith('redis-save', expect.anything());
  });
});

describe('a snapshot over the saved-copy cap (review R2a-07)', () => {
  /** A store that refuses every save for its size, as the real one does over 4 MB. */
  function tooLargeStore(outcome: 'too-large' | 'saved' = 'too-large') {
    return {
      load: vi.fn(async () => null),
      save: vi.fn(async () => outcome),
    };
  }

  it('tells the operator once per version, with the size — a warning for «Системные события», not a line per save', async () => {
    const reports: Array<{ level?: string; message: string; context?: Record<string, unknown> }> = [];
    const persistence = new RedisPublicConfigPersistence({
      redis: {} as never,
      rejectionNotifier: createPublicConfigRejectionNotifier({ errorReporter: { report: (r) => reports.push(r) } }),
      store: tooLargeStore(),
    });

    // The TTL refresh saves the same version every minute.
    await persistence.save(SNAPSHOT, 'a'.repeat(32));
    await persistence.save(SNAPSHOT, 'a'.repeat(32));
    await persistence.save({ ...SNAPSHOT, defaultCurrency: 'RUB' }, 'b'.repeat(32));

    expect(reports.map((report) => report.context?.['version'])).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    expect(reports[0]).toMatchObject({
      level: 'warning',
      context: {
        event: 'reiwa.config.copy_not_saved',
        group: 'public-config',
        bytes: Buffer.byteLength(JSON.stringify(SNAPSHOT), 'utf8'),
        maxBytes: 4 * 1024 * 1024,
      },
    });
    expect(String(reports[0]?.context?.['why'])).toMatch(/больше предела 4,0 МБ/);
  });

  it('says nothing when the copy was saved', async () => {
    const reports: unknown[] = [];
    const persistence = new RedisPublicConfigPersistence({
      redis: {} as never,
      rejectionNotifier: createPublicConfigRejectionNotifier({ errorReporter: { report: (r) => reports.push(r) } }),
      store: tooLargeStore('saved'),
    });
    await persistence.save(SNAPSHOT, 'a'.repeat(32));
    expect(reports).toEqual([]);
  });
});

describe('the public config’s held version', () => {
  beforeEach(() => resetBrandingCache());
  afterEach(() => resetBrandingCache());

  it('is null while nothing is held, and the version of the body held once one is', async () => {
    expect(heldPublicConfigVersion()).toBeNull();
    await getPublicConfigPayload({ branding: { getReiwaPublicConfig: async () => SNAPSHOT } } as never);
    expect(heldPublicConfigVersion()).toBe(configVersionOf(SNAPSHOT));
    resetBrandingCache();
    expect(heldPublicConfigVersion()).toBeNull();
  });
});
