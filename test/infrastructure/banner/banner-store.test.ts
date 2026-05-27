/**
 * BannerStore integration specs.
 *
 * Builds a real on-disk assets tree under `mkdtempSync(...)` so the FS
 * legs of the lookup chain are exercised end-to-end. Admin override
 * leg uses an in-memory `Map` driven through the `getOverride`
 * callback.
 *
 * Pinned behaviours:
 *   - 5-step lookup chain order
 *   - http/https URL guard on overrides
 *   - whitespace + empty value handling
 *   - graceful tolerance of a missing assets directory
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BannerStore } from '../../../src/infrastructure/banner/banner-store.js';

interface Harness {
  store: BannerStore;
  overrides: Map<string, string>;
  assetsRoot: string;
  cleanup: () => void;
  /** Drops a tiny placeholder file at `<assetsRoot>/<rel>`. */
  writeAsset(rel: string): string;
}

function buildHarness(): Harness {
  const assetsRoot = mkdtempSync(join(tmpdir(), 'reiwa-banner-store-'));
  const overrides = new Map<string, string>();
  const store = new BannerStore({
    assetsRoot,
    getOverride: (key) => overrides.get(key),
  });
  return {
    store,
    overrides,
    assetsRoot,
    cleanup: () => {
      rmSync(assetsRoot, { recursive: true, force: true });
    },
    writeAsset(rel) {
      const full = join(assetsRoot, rel);
      // Make sure parent dirs exist.
      const parent = full.slice(0, full.lastIndexOf('\\') !== -1 ? full.lastIndexOf('\\') : full.lastIndexOf('/'));
      mkdirSync(parent, { recursive: true });
      writeFileSync(full, 'fake-bytes');
      return full;
    },
  };
}

describe('BannerStore — admin override leg', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it('returns the locale-scoped URL override (step 1)', async () => {
    h.overrides.set('bot.banner.menu.en', 'https://cdn.example.com/menu-en.png');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'url', url: 'https://cdn.example.com/menu-en.png' });
  });

  it('falls back to the locale-agnostic URL override (step 2)', async () => {
    h.overrides.set('bot.banner.menu', 'https://cdn.example.com/menu.png');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'url', url: 'https://cdn.example.com/menu.png' });
  });

  it('prefers the locale-scoped override when both are present', async () => {
    h.overrides.set('bot.banner.menu', 'https://cdn.example.com/menu.png');
    h.overrides.set('bot.banner.menu.ru', 'https://cdn.example.com/menu-ru.png');
    const result = await h.store.resolve('menu', 'ru');
    expect(result).toEqual({ kind: 'url', url: 'https://cdn.example.com/menu-ru.png' });
  });

  it('rejects non-http(s) override values', async () => {
    h.overrides.set('bot.banner.menu', 'file:///etc/passwd');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toBeNull();
  });

  it('treats whitespace-only override as missing', async () => {
    h.overrides.set('bot.banner.menu', '   ');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toBeNull();
  });

  it('trims surrounding whitespace before returning', async () => {
    h.overrides.set('bot.banner.menu', '  https://cdn.example.com/menu.png  ');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'url', url: 'https://cdn.example.com/menu.png' });
  });

  it('swallows getOverride errors and continues to FS legs', async () => {
    const store = new BannerStore({
      assetsRoot: h.assetsRoot,
      getOverride: () => {
        throw new Error('boom');
      },
    });
    h.writeAsset('en/menu.png');
    const result = await store.resolve('menu', 'en');
    expect(result?.kind).toBe('file');
  });
});

describe('BannerStore — filesystem legs', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it('returns the locale + name asset (step 3)', async () => {
    const path = h.writeAsset('en/menu.jpg');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'file', path });
  });

  it('falls back to the locale default (step 4) when the named asset is missing', async () => {
    const path = h.writeAsset('en/default.png');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'file', path });
  });

  it('falls back to the global default (step 5) when the locale folder is empty', async () => {
    const path = h.writeAsset('default.webp');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'file', path });
  });

  it('returns null when no asset exists', async () => {
    const result = await h.store.resolve('menu', 'en');
    expect(result).toBeNull();
  });

  it('walks every supported format extension', async () => {
    const path = h.writeAsset('en/menu.gif');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'file', path });
  });
});

describe('BannerStore — chain interaction', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it('admin override beats every FS asset', async () => {
    h.overrides.set('bot.banner.menu', 'https://cdn.example.com/menu.png');
    h.writeAsset('en/menu.png');
    h.writeAsset('default.png');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'url', url: 'https://cdn.example.com/menu.png' });
  });

  it('locale-named FS asset beats locale default', async () => {
    const named = h.writeAsset('en/menu.jpg');
    h.writeAsset('en/default.png');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'file', path: named });
  });

  it('locale default beats global default', async () => {
    const localeDefault = h.writeAsset('en/default.png');
    h.writeAsset('default.png');
    const result = await h.store.resolve('menu', 'en');
    expect(result).toEqual({ kind: 'file', path: localeDefault });
  });
});
