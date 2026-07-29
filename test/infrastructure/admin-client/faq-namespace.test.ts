import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { FaqNamespace } from '../../../src/infrastructure/admin-client/namespaces/faq.js';

describe('FaqNamespace media delivery', () => {
  it('confines the request to /uploads/faq and forwards the Range header', async () => {
    const result = {
      status: 206,
      contentType: 'video/mp4',
      contentLength: 10,
      contentRange: 'bytes 0-9/100',
      acceptRanges: 'bytes',
      etag: null,
      lastModified: null,
      body: Readable.from('0123456789'),
    };
    const fetchBinary = vi.fn(async () => result);
    const namespace = new FaqNamespace({ fetchBinary } as never);

    await expect(namespace.downloadMedia('guide intro.mp4', 'bytes=0-9')).resolves.toBe(result);
    expect(fetchBinary).toHaveBeenCalledWith(
      '/uploads/faq/guide%20intro.mp4',
      { Range: 'bytes=0-9' },
      { includeErrorResponses: true },
    );
  });

  it('does not send an empty Range header on a full media request', async () => {
    const fetchBinary = vi.fn(async () => null);
    const namespace = new FaqNamespace({ fetchBinary } as never);

    await namespace.downloadMedia('guide.mp4');
    expect(fetchBinary).toHaveBeenCalledWith(
      '/uploads/faq/guide.mp4',
      {},
      { includeErrorResponses: true },
    );
  });
});
