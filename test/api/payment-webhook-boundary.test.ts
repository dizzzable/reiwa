import { createHmac } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createPaymentsRouter } from '../../src/api/routes/payments.js';
import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';

async function post(app: express.Express, path: string, body: unknown, headers: Record<string, string> = {}) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const raw = JSON.stringify(body);
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject); req.end(raw);
    });
  } finally { server.close(); }
}

describe('payment webhook boundary', () => {
  it('does not expose the removed public payment relay', async () => {
    const forwardWebhook = vi.fn();
    const app = express(); app.use(express.json());
    app.use('/api/v1', createPaymentsRouter({ adminClient: { payments: { forwardWebhook } } as never, sessionStore: null, config: {} as never }));
    expect(await post(app, '/api/v1/payments/webhooks/YOOKASSA', { status: 'succeeded' })).toBe(404);
    expect(forwardWebhook).not.toHaveBeenCalled();
  });
  it('rejects oversized signed metadata before bot relay', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const body = { event: 'reiwa.user.notify', metadata: { eventId: 'event-1', telegramId: '123456', text: 'x'.repeat(4097) } };
    const raw = JSON.stringify(body); const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', 'webhook-secret').update(`${timestamp}.${raw}`).digest('hex');
    const app = express(); app.use(express.json({ verify: (req, _res, buffer) => { (req as { rawBody?: Buffer }).rawBody = buffer; } }));
    app.use('/api/v1', createRezeisWebhookRouter({ config: { REZEIS_WEBHOOK_SECRET: 'webhook-secret', REIWA_BOT_INTERNAL_URL: 'http://reiwa-bot:5100', REZEIS_INTERNAL_SHARED_SECRET: 's'.repeat(32) } as never }));
    expect(await post(app, '/api/v1/webhooks/rezeis', body, { 'x-rezeis-signature': `t=${timestamp},v1=${signature}` })).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled(); fetchMock.mockRestore();
  });
});
