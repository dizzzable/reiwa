import { describe, expect, it, vi } from 'vitest';

import { resolveBannerSource } from '../../../src/bot/pages/banner-resolver.js';

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

  it('answers null, and warns, when the upload body dies while it is being read', async () => {
    // rezeis answered 200 and dropped the connection mid-body: undici rejects
    // the body read with `TypeError: terminated`. Every caller falls through to
    // no banner on `null` — the notification relay sends text, `/start` and
    // the screens their fallback — so a rejection here would take the whole
    // message down with the decoration.
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff]));
              controller.error(new TypeError('terminated'));
            },
          }),
        ),
    );
    const warn = vi.fn();

    const result = await resolveBannerSource('/uploads/bot-banners/summer.jpg', {
      rezeisAdminUrl: 'http://rezeis:8000',
      fetch: fetcher,
      logger: { warn },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ fullUrl: 'http://rezeis:8000/uploads/bot-banners/summer.jpg' }),
      expect.stringContaining('banner-resolver'),
    );
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
