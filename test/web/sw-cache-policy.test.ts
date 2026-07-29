import { describe, expect, it } from 'vitest';

import { isCacheableApiPath } from '../../web/src/sw-cache-policy.js';

describe('service-worker public API cache policy', () => {
  it('never caches live FAQ content or its media', () => {
    expect(isCacheableApiPath('/api/v1/faq')).toBe(false);
    expect(isCacheableApiPath('/api/v1/faq/media/guide.mp4')).toBe(false);
  });

  it('continues caching bounded public catalogs', () => {
    expect(isCacheableApiPath('/api/v1/branding')).toBe(true);
    expect(isCacheableApiPath('/api/v1/plans')).toBe(true);
    expect(isCacheableApiPath('/api/v1/gateways')).toBe(true);
    expect(isCacheableApiPath('/api/v1/landing')).toBe(true);
  });

  it('does not cache lookalike or account-scoped paths', () => {
    expect(isCacheableApiPath('/api/v1/faq?locale=ru')).toBe(false);
    expect(isCacheableApiPath('/api/v1/plans/private')).toBe(false);
    expect(isCacheableApiPath('/api/v1/subscription')).toBe(false);
  });
});
