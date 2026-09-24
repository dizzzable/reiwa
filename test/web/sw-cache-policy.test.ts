import { describe, expect, it } from 'vitest';

import {
  apiCacheKey,
  isCacheableApiPath,
  isVersionedConfigRead,
} from '../../web/src/sw-cache-policy.js';

describe('service-worker public API cache policy', () => {
  it('never caches live FAQ content or its media', () => {
    expect(isCacheableApiPath('/api/v1/faq')).toBe(false);
    expect(isCacheableApiPath('/api/v1/faq/media/guide.mp4')).toBe(false);
  });

  it('continues caching bounded public catalogs', () => {
    expect(isCacheableApiPath('/api/v1/branding')).toBe(true);
    expect(isCacheableApiPath('/api/v1/gateways')).toBe(true);
    expect(isCacheableApiPath('/api/v1/landing')).toBe(true);
  });

  it('never caches the plan catalogue, which the panel resolves for the signed-in subscriber', () => {
    // One URL, one stored copy, whoever asked: plans offered only to that
    // subscriber and their personal prices were served from the cache to the
    // next account signed in on the same browser whenever the network was slow.
    expect(isCacheableApiPath('/api/v1/plans')).toBe(false);
  });

  it('does not cache lookalike or account-scoped paths', () => {
    expect(isCacheableApiPath('/api/v1/faq?locale=ru')).toBe(false);
    expect(isCacheableApiPath('/api/v1/plans/private')).toBe(false);
    expect(isCacheableApiPath('/api/v1/subscription')).toBe(false);
  });

  it('tells a read the version watcher asked for from a plain one', () => {
    expect(isVersionedConfigRead(new URL('https://reiwa.example/api/v1/landing?v=abc'))).toBe(true);
    expect(isVersionedConfigRead(new URL('https://reiwa.example/api/v1/landing'))).toBe(false);
    expect(isVersionedConfigRead(new URL('https://reiwa.example/api/v1/landing?view=abc'))).toBe(false);
  });

  it('keys a cached response by its URL without the version, and without nothing else', () => {
    expect(apiCacheKey('https://reiwa.example/api/v1/landing?v=abc')).toBe('https://reiwa.example/api/v1/landing');
    expect(apiCacheKey('https://reiwa.example/api/v1/landing?v=def')).toBe('https://reiwa.example/api/v1/landing');
    expect(apiCacheKey('https://reiwa.example/api/v1/gateways?v=1&c=RUB')).toBe('https://reiwa.example/api/v1/gateways?c=RUB');
    expect(apiCacheKey('https://reiwa.example/api/v1/gateways')).toBe('https://reiwa.example/api/v1/gateways');
  });
});
