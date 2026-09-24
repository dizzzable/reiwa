import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRANDING_ASSET_UNUSED_TTL_MS, BrandingAssetCache } from '../../src/api/branding-pwa.js';

/**
 * The logo / PWA-icon mirror is no longer wiped on every branding save (W8
 * report D7), so what nobody asks for any more is pruned instead: a file's
 * timestamp says when it was last served, and a month unserved removes it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describe('BrandingAssetCache.prune', () => {
  let dir: string;
  let cache: BrandingAssetCache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'branding-prune-'));
    cache = new BrandingAssetCache(dir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, ageMs: number): Promise<string> {
    const full = path.join(dir, name);
    await fs.writeFile(full, Buffer.from([1, 2, 3]));
    const at = new Date(Date.now() - ageMs);
    await fs.utimes(full, at, at);
    return full;
  }

  const exists = (full: string): Promise<boolean> =>
    fs.stat(full).then(
      () => true,
      () => false,
    );

  it('removes what was not served for 30 days and keeps the rest', async () => {
    const old = await file('old-logo.png', 31 * DAY_MS);
    const recent = await file('logo.png', 2 * DAY_MS);

    expect(await cache.prune()).toBe(1);

    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  it('keeps a month by default — the horizon is not an accident', () => {
    // Literal on purpose: a fixture read from the constant would move with it.
    expect(BRANDING_ASSET_UNUSED_TTL_MS).toBe(30 * DAY_MS);
  });

  it('serving a file renews it, so a logo in use is never pruned however old its fetch', async () => {
    const logo = await file('logo.png', 40 * DAY_MS);

    const served = await cache.resolve({ file: 'logo.png', adminBaseUrl: null });
    expect(served?.buffer.length).toBe(3);
    await vi.waitFor(async () => {
      expect(Date.now() - (await fs.stat(logo)).mtimeMs).toBeLessThan(DAY_MS);
    });

    expect(await cache.prune()).toBe(0);
    expect(await exists(logo)).toBe(true);
  });

  it('answers 0 for a mirror that was never created', async () => {
    const missing = new BrandingAssetCache(path.join(dir, 'never-created'));
    expect(await missing.prune()).toBe(0);
  });
});
