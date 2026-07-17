import { describe, expect, it, vi } from 'vitest';

import { resolveBannerSource } from '../../../src/bot/pages/banner-resolver';

describe('resolveBannerSource', () => {
  it('fetches a canonical upload path from the configured admin origin', async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.from('image')));

    const result = await resolveBannerSource('/uploads/bot-flow/screen-1.webp', {
      rezeisAdminUrl: 'http://rezeis:8000',
      fetch: fetcher,
    });

    expect(result).not.toBeNull();
    expect(fetcher).toHaveBeenCalledWith('http://rezeis:8000/uploads/bot-flow/screen-1.webp');
  });

  it('does not fetch an upload path that escapes the upload namespace', async () => {
    const fetcher = vi.fn();

    const result = await resolveBannerSource('/uploads/../api/internal/backups', {
      rezeisAdminUrl: 'http://rezeis:8000',
      fetch: fetcher,
    });

    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
