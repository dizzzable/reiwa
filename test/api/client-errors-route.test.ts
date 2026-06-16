import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createClientErrorsRouter } from '../../src/api/routes/client-errors.js';

/**
 * POST /api/v1/client-errors — the web/TMA cabinet's runtime errors must be
 * forwarded into the firehose with `source: 'web'`, and empty payloads
 * rejected. The endpoint is best-effort (204 on success).
 */

function makeApp(report: (input: Record<string, unknown>) => Promise<unknown>) {
  const adminClient = { system: { reportError: report } };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createClientErrorsRouter({ adminClient: adminClient as never }));
  return app;
}

async function post(app: express.Express, path: string, body: unknown): Promise<number> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify(body);
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    server.close();
  }
}

describe('client-errors route', () => {
  it('forwards a client error as a web-source report and answers 204', async () => {
    const report = vi.fn(async () => ({ ok: true }));
    const status = await post(makeApp(report), '/api/v1/client-errors', {
      message: 'Cannot read properties of undefined',
      kind: 'react.errorBoundary',
      surface: 'tma',
      componentStack: 'at Dashboard',
    });
    expect(status).toBe(204);
    await new Promise((r) => setTimeout(r, 0));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      source: 'web',
      message: 'Cannot read properties of undefined',
    });
    const ctx = (report.mock.calls[0][0] as { context: Record<string, unknown> }).context;
    expect(ctx).toMatchObject({ surface: 'tma', scope: 'web.react.errorBoundary' });
  });

  it('rejects an empty message with 400 and does not report', async () => {
    const report = vi.fn(async () => ({ ok: true }));
    const status = await post(makeApp(report), '/api/v1/client-errors', { message: '   ' });
    expect(status).toBe(400);
    await new Promise((r) => setTimeout(r, 0));
    expect(report).not.toHaveBeenCalled();
  });
});
