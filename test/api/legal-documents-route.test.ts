import express from 'express';
import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { createContentRouter } from '../../src/api/routes/content.js';

/**
 * The public legal-documents endpoint.
 *
 * Two things here are decisions rather than plumbing, and both are about what
 * happens when the panel is unreachable.
 *
 * **An outage must not look like "nothing is required".** If this route
 * answered an empty list on failure, the sign-up form would render no
 * checkboxes, submit happily, and the panel would then refuse the registration
 * for consent that was never asked for. The visitor sees a rejection with no
 * cause anywhere on screen. So: 502, and the form says the terms could not be
 * loaded.
 *
 * **The response must never be cached.** A legal text is exactly the thing that
 * must not be served from a stale copy — an operator who rewrites a document,
 * or switches one off, has to be obeyed on the next request rather than
 * whenever some TTL happens to lapse.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface LegalClientDouble {
  readonly list: (locale?: string | null) => Promise<readonly unknown[]>;
}

function makeApp(legalDocuments: LegalClientDouble | null): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof silentLogger }).log = silentLogger;
    next();
  });
  const adminClient = legalDocuments === null ? null : ({ legalDocuments } as never);
  app.use(
    '/api/v1',
    createContentRouter({ adminClient, sessionStore: null, config: {} as never }),
  );
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: string; cacheControl: string | null }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return {
      status: response.status,
      body: await response.text(),
      cacheControl: response.headers.get('cache-control'),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /api/v1/legal-documents', () => {
  it('returns the documents the panel reports as active', async () => {
    const app = makeApp({
      list: async () => [{ key: 'USER_AGREEMENT', title: 'Соглашение', body: 'Текст' }],
    });

    const response = await get(app, '/api/v1/legal-documents?locale=ru');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      documents: [{ key: 'USER_AGREEMENT', title: 'Соглашение', body: 'Текст' }],
    });
  });

  it('answers 502 rather than an empty list when the panel is unreachable', async () => {
    const app = makeApp({
      list: async () => {
        throw new Error('upstream down');
      },
    });

    const response = await get(app, '/api/v1/legal-documents');

    expect(response.status).toBe(502);
    // The distinction that matters: NOT a 200 with no documents, which the
    // sign-up form would read as "the operator requires nothing".
    expect(response.body).not.toContain('"documents":[]');
  });

  it('forbids caching so an operator edit takes effect on the next request', async () => {
    const app = makeApp({ list: async () => [] });

    const response = await get(app, '/api/v1/legal-documents');

    expect(response.cacheControl).toBe('no-store');
  });

  it('passes the requested locale through to the panel', async () => {
    const seen: Array<string | null | undefined> = [];
    const app = makeApp({
      list: async (locale) => {
        seen.push(locale);
        return [];
      },
    });

    await get(app, '/api/v1/legal-documents?locale=en');

    expect(seen).toEqual(['en']);
  });

  it('returns an empty list — not an error — when the operator enabled nothing', async () => {
    const app = makeApp({ list: async () => [] });

    const response = await get(app, '/api/v1/legal-documents');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ documents: [] });
  });
});
