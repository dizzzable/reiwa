import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createContentRouter } from '../../src/api/routes/content.js';

const FILE_NAME = '0123456789abcdef0123456789abcdef.mp4';
const MEDIA_PATH = `/api/v1/faq/media/${FILE_NAME}`;

interface BinaryResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly contentRange: string | null;
  readonly acceptRanges: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly body: NodeJS.ReadableStream;
}

interface FaqClientDouble {
  readonly getPublicFaq: (locale?: string) => Promise<readonly unknown[]>;
  readonly downloadMedia: (
    fileName: string,
    range?: string,
  ) => Promise<BinaryResult | null>;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

function makeApp(faq: FaqClientDouble | null): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof silentLogger }).log = silentLogger;
    next();
  });
  const adminClient = faq === null ? null : ({ faq } as never);
  app.use(
    '/api/v1',
    createContentRouter({ adminClient, sessionStore: null, config: {} as never }),
  );
  return app;
}

function faqDouble(overrides: Partial<FaqClientDouble> = {}): FaqClientDouble {
  return {
    getPublicFaq: async () => [],
    downloadMedia: async () => null,
    ...overrides,
  };
}

async function request(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function binary(
  body: string,
  overrides: Partial<Omit<BinaryResult, 'body'>> = {},
): BinaryResult {
  const payload = Buffer.from(body);
  return {
    status: 200,
    contentType: 'video/mp4',
    contentLength: payload.length,
    contentRange: null,
    acceptRanges: 'bytes',
    etag: '"faq-etag"',
    lastModified: 'Wed, 29 Jul 2026 12:00:00 GMT',
    body: Readable.from(payload),
    ...overrides,
  };
}

describe('FAQ content and same-origin media delivery', () => {
  it('rewrites relative uploads, preserves external HTTPS URLs and drops unsafe references', async () => {
    const getPublicFaq = vi.fn(async () => [
      {
        id: 'faq-1',
        question: 'How?',
        answer: 'Watch the guide',
        mediaUrls: [
          `/uploads/faq/${FILE_NAME}`,
          'https://cdn.example.com/guides/intro.webm',
          'http://cdn.example.com/insecure.mp4',
          '/uploads/faq/../secret.mp4',
          'javascript:alert(1)',
        ],
        orderIndex: 0,
        locale: 'en',
      },
    ]);
    const response = await request(makeApp(faqDouble({ getPublicFaq })), '/api/v1/faq?locale=en');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(getPublicFaq).toHaveBeenCalledWith('en');
    expect(JSON.parse(response.body.toString('utf8')).items[0].mediaUrls).toEqual([
      MEDIA_PATH,
      'https://cdn.example.com/guides/intro.webm',
    ]);
  });

  it('keeps the empty FAQ fallback only when no admin client is configured', async () => {
    const response = await request(makeApp(null), '/api/v1/faq');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ items: [] });
  });

  it('returns a safe 502 instead of a cacheable empty FAQ on an upstream exception', async () => {
    const getPublicFaq = vi.fn(async () => {
      throw new Error('internal rezeis address and secret diagnostics');
    });
    const response = await request(makeApp(faqDouble({ getPublicFaq })), '/api/v1/faq');

    expect(response.status).toBe(502);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ message: 'FAQ unavailable' });
    expect(response.body.toString('utf8')).not.toContain('rezeis address');
  });

  it('streams an allowed image/video with immutable same-origin headers', async () => {
    const downloadMedia = vi.fn(async () => binary('video-data'));
    const response = await request(makeApp(faqDouble({ downloadMedia })), MEDIA_PATH);

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('video-data');
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(downloadMedia).toHaveBeenCalledWith(FILE_NAME, undefined);
  });

  it('forwards a browser byte range and preserves the 206 response metadata', async () => {
    const downloadMedia = vi.fn(async (_fileName: string, range?: string) =>
      binary('data', {
        status: 206,
        contentLength: 4,
        contentRange: 'bytes 10-13/100',
        acceptRanges: 'bytes',
      }),
    );
    const response = await request(makeApp(faqDouble({ downloadMedia })), MEDIA_PATH, {
      Range: 'bytes=10-13',
    });

    expect(response.status).toBe(206);
    expect(response.body.toString('utf8')).toBe('data');
    expect(response.headers['content-range']).toBe('bytes 10-13/100');
    expect(response.headers['content-length']).toBe('4');
    expect(downloadMedia).toHaveBeenCalledWith(FILE_NAME, 'bytes=10-13');
  });

  it('returns 404 when the immutable upstream file no longer exists', async () => {
    const response = await request(makeApp(faqDouble()), MEDIA_PATH);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      message: 'FAQ media not found',
    });
  });

  it('rejects encoded traversal before calling rezeis', async () => {
    const downloadMedia = vi.fn(async () => binary('must-not-be-read'));
    const response = await request(
      makeApp(faqDouble({ downloadMedia })),
      '/api/v1/faq/media/%2e%2e%2fsecret.mp4',
    );

    expect(response.status).toBe(400);
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('maps a media upstream exception to a safe 502', async () => {
    const downloadMedia = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED rezeis-admin:8000');
    });
    const response = await request(makeApp(faqDouble({ downloadMedia })), MEDIA_PATH);

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      message: 'FAQ media unavailable',
    });
    expect(response.body.toString('utf8')).not.toContain('ECONNREFUSED');
  });

  it('rejects malformed and multi-range requests without contacting rezeis', async () => {
    const downloadMedia = vi.fn(async () => binary('must-not-be-read'));
    const app = makeApp(faqDouble({ downloadMedia }));

    const malformed = await request(app, MEDIA_PATH, { Range: 'items=0-10' });
    const multiRange = await request(app, MEDIA_PATH, { Range: 'bytes=0-1,4-5' });

    expect(malformed.status).toBe(416);
    expect(multiRange.status).toBe(416);
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('returns a safe 502 when an upstream 206 omits Content-Range', async () => {
    const downloadMedia = vi.fn(async () =>
      binary('data', { status: 206, contentLength: 4, contentRange: null }),
    );
    const response = await request(makeApp(faqDouble({ downloadMedia })), MEDIA_PATH, {
      Range: 'bytes=0-3',
    });

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      message: 'FAQ media unavailable',
    });
  });

  it('rejects an HTML SPA fallback instead of serving it as FAQ media', async () => {
    const downloadMedia = vi.fn(async () =>
      binary('<!doctype html>', {
        contentType: 'text/html; charset=utf-8',
        contentLength: 15,
      }),
    );
    const response = await request(makeApp(faqDouble({ downloadMedia })), MEDIA_PATH);

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      message: 'FAQ media unavailable',
    });
    expect(response.body.toString('utf8')).not.toContain('<!doctype html>');
  });

  it('preserves an upstream 416 response for an unsatisfiable range', async () => {
    const downloadMedia = vi.fn(async () =>
      binary('', {
        status: 416,
        contentLength: 0,
        contentRange: 'bytes */100',
      }),
    );
    const response = await request(makeApp(faqDouble({ downloadMedia })), MEDIA_PATH, {
      Range: 'bytes=100-200',
    });

    expect(response.status).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */100');
  });
});
