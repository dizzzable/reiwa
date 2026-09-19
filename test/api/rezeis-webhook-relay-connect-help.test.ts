import { createHmac } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';

/**
 * The bot's «📲 Подключить» on «Не получилось подключиться?» reaches the bot
 * with its deep link whole.
 *
 * The panel sends the button as a Mini App path, `webAppPath:
 * '/dashboard?connect=help&subscriptionId=<id>'`, and the bot builds
 * `${miniAppUrl}${path}` from it. The path carries TWO parameters, so the `&`
 * is the part a relay that "cleaned" query strings would lose — and the
 * dashboard would then open with no card named, or with no link at all.
 * `rezeis-webhook-relay.test.ts` pins a one-parameter promo path; this pins
 * the shape the connect-help notice actually sends.
 */

const WEBHOOK_SECRET = 'webhook-secret';

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function buildApp(): express.Express {
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
  return app;
}

/** One webhook through the app, with no port bound. */
function post(app: express.Express, body: unknown): Promise<{ status: number }> {
  const raw = JSON.stringify(body);
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  const request = new IncomingMessage(socket);
  request.method = 'POST';
  request.url = '/api/v1/webhooks/rezeis';
  request.headers = {
    host: '127.0.0.1',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
    'x-rezeis-signature': sign(raw),
  };
  const response = new ServerResponse(request);
  const settled = new Promise<{ status: number }>((resolve) => {
    (response as unknown as { write: unknown }).write = (): boolean => true;
    (response as unknown as { end: unknown }).end = (): ServerResponse => {
      resolve({ status: response.statusCode });
      return response;
    };
  });
  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(request, response);
  request.push(raw);
  request.push(null);
  return settled;
}

describe('the connect-help button on its way to the bot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps both parameters of the deep link', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ messageId: 42 }), { status: 200 }));
    const path = '/dashboard?connect=help&subscriptionId=cmsub0001abcdefghijklmno';

    const { status } = await post(buildApp(), {
      event: 'reiwa.user.notify',
      metadata: {
        eventId: 'evt-connect-help-1',
        telegramId: '123456789',
        text: 'Не получилось подключиться?',
        buttons: [
          { text: '📲 Подключить', webAppPath: path },
          { text: '💬 Поддержка', webAppPath: '/support' },
        ],
      },
    });

    expect(status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://reiwa-bot:5100/notify');
    const relayed = JSON.parse(String(init.body)) as { buttons?: unknown };
    expect(relayed.buttons).toEqual([
      { text: '📲 Подключить', webAppPath: path },
      { text: '💬 Поддержка', webAppPath: '/support' },
    ]);
  });
});
