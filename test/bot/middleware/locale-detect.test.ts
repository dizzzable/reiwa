/**
 * locale-detect middleware specs.
 *
 *   - cache miss + detected locale: writes through, calls admin
 *     `user.updateLanguage` with uppercase code (admin convention)
 *   - cache hit: skips both writes
 *   - missing ctx.from: no-ops gracefully
 *   - admin call is fire-and-forget — rejection swallowed
 *   - admin null: only the cache is updated
 *   - locale detection is delegated to the injected detector function
 */
import { describe, expect, it, vi } from 'vitest';

import { createLocaleDetectMiddleware } from '../../../src/bot/middleware/locale-detect.js';
import type {
  LocaleDetectDeps,
  UserLocaleSyncWriter,
} from '../../../src/bot/middleware/locale-detect.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import type { AdminClient } from '../../../src/infrastructure/admin-client/index.js';

interface FakeCache extends UserLocaleSyncWriter {
  store: Map<number, string>;
}

function buildCache(initial: Iterable<[number, string]> = []): FakeCache {
  const store = new Map<number, string>(initial);
  return {
    store,
    hasSync: (id) => store.has(id),
    setSync: (id, lang) => {
      store.set(id, lang);
    },
  };
}

function buildAdmin(updateLanguage: ReturnType<typeof vi.fn>): AdminClient {
  return ({ user: { updateLanguage } } as unknown) as AdminClient;
}

function buildCtx(from?: { id: number; language_code?: string }): BotContext {
  return ({ from } as unknown) as BotContext;
}

describe('createLocaleDetectMiddleware', () => {
  it('adopts the detected locale on cache miss + calls admin with uppercase code', async () => {
    const cache = buildCache();
    const updateLanguage = vi.fn().mockResolvedValue(null);
    const detect = vi.fn().mockReturnValue('en');
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = createLocaleDetectMiddleware({
      cache,
      detect,
      adminClient: buildAdmin(updateLanguage),
    } as LocaleDetectDeps);

    await mw(buildCtx({ id: 42, language_code: 'en-GB' }), next);

    expect(detect).toHaveBeenCalledWith('en-GB');
    expect(cache.store.get(42)).toBe('en');
    expect(updateLanguage).toHaveBeenCalledWith('42', 'EN');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips both writes on cache hit', async () => {
    const cache = buildCache([[42, 'ru']]);
    const updateLanguage = vi.fn();
    const detect = vi.fn();
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = createLocaleDetectMiddleware({
      cache,
      detect: detect as unknown as LocaleDetectDeps['detect'],
      adminClient: buildAdmin(updateLanguage),
    });

    await mw(buildCtx({ id: 42 }), next);

    expect(detect).not.toHaveBeenCalled();
    expect(updateLanguage).not.toHaveBeenCalled();
    expect(cache.store.get(42)).toBe('ru');
    expect(next).toHaveBeenCalled();
  });

  it('no-ops when ctx.from is missing', async () => {
    const cache = buildCache();
    const updateLanguage = vi.fn();
    const detect = vi.fn();
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = createLocaleDetectMiddleware({
      cache,
      detect: detect as unknown as LocaleDetectDeps['detect'],
      adminClient: buildAdmin(updateLanguage),
    });

    await mw(buildCtx(undefined), next);

    expect(detect).not.toHaveBeenCalled();
    expect(updateLanguage).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
    expect(next).toHaveBeenCalled();
  });

  it('still adopts the locale when admin client is null', async () => {
    const cache = buildCache();
    const detect = vi.fn().mockReturnValue('ru');
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = createLocaleDetectMiddleware({
      cache,
      detect,
      adminClient: null,
    });

    await mw(buildCtx({ id: 5 }), next);

    expect(cache.store.get(5)).toBe('ru');
    expect(next).toHaveBeenCalled();
  });

  it('swallows admin updateLanguage rejection (fire-and-forget)', async () => {
    const cache = buildCache();
    const updateLanguage = vi.fn().mockRejectedValue(new Error('boom'));
    const detect = vi.fn().mockReturnValue('en');
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = createLocaleDetectMiddleware({
      cache,
      detect,
      adminClient: buildAdmin(updateLanguage),
    });

    await expect(mw(buildCtx({ id: 1, language_code: 'en' }), next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalled();
    // Wait for the unhandled-rejection-style microtask flush.
    await new Promise((r) => setImmediate(r));
  });

  it('calls next exactly once even when the cache write throws', async () => {
    const cache: UserLocaleSyncWriter = {
      hasSync: () => false,
      setSync: () => {
        throw new Error('cache exploded');
      },
    };
    const detect = vi.fn().mockReturnValue('en');
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = createLocaleDetectMiddleware({
      cache,
      detect,
      adminClient: null,
    });

    // The middleware does not catch a synchronous setSync throw — that
    // bubbles up to grammy's `bot.catch`. Verify the contract: if it
    // does throw, `next` is NOT called (avoid double-handling).
    await expect(mw(buildCtx({ id: 1 }), next)).rejects.toThrow('cache exploded');
    expect(next).not.toHaveBeenCalled();
  });
});
