import { createHmac } from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';

const WEBHOOK_SECRET = 'webhook-secret';

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function post(app: express.Express, body: unknown, signature: string): Promise<number> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const raw = JSON.stringify(body);
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/webhooks/rezeis',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            'x-rezeis-signature': signature,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
  } finally {
    server.close();
  }
}

describe('Rezeis webhook relay', () => {
  it('relays a full error report to the exact operator topic', async () => {
    const body = {
      event: 'reiwa.channel.broadcast.document',
      metadata: {
        eventId: 'sysevt:reiwa.error:2026-07-24T18:33:24.848Z:error-report',
        chatId: '-1001234567890',
        topicThreadId: 77,
        filename: 'error_20260724.txt',
        content: 'full error report',
        caption: '<b>Error</b>',
        parseMode: 'HTML',
      },
    };
    const raw = JSON.stringify(body);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buffer) => {
          (req as { rawBody?: Buffer }).rawBody = buffer;
        },
      }),
    );
    app.use(
      '/api/v1',
      createRezeisWebhookRouter({
        config: {
          REZEIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
          REIWA_BOT_INTERNAL_URL: 'http://reiwa-bot:5100',
          REZEIS_INTERNAL_SHARED_SECRET: 's'.repeat(32),
        } as never,
      }),
    );

    try {
      expect(await post(app, body, sign(raw))).toBe(204);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://reiwa-bot:5100/notify-broadcast-document');
      expect(JSON.parse(String(init.body))).toMatchObject({
        eventId: body.metadata.eventId,
        chatId: body.metadata.chatId,
        topicThreadId: 77,
        filename: body.metadata.filename,
        content: body.metadata.content,
        caption: body.metadata.caption,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
