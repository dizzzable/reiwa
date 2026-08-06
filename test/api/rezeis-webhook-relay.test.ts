import { createHmac } from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRezeisWebhookRouter } from '../../src/api/routes/webhooks.js';

const WEBHOOK_SECRET = 'webhook-secret';

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
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

async function post(
  app: express.Express,
  body: unknown,
  signature: string,
): Promise<{ status: number; text: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const raw = JSON.stringify(body);
  try {
    return await new Promise<{ status: number; text: string }>((resolve, reject) => {
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
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
  } finally {
    server.close();
  }
}

/**
 * Post a `{ event, metadata }` webhook, capturing the payload the router
 * relays to the bot. Returns the HTTP status plus the relayed path + body so a
 * test can assert both that the webhook accepted the payload (not 400) and that
 * it forwarded the exact contract the bot expects. `response` is what the
 * webhook itself answered with — the half rezeis reads back.
 */
async function relay(
  event: string,
  metadata: Record<string, unknown>,
  botStatus = 204,
  botBody: unknown = null,
): Promise<{
  status: number;
  url: string | null;
  body: Record<string, unknown> | null;
  response: string;
}> {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(botBody === null ? null : JSON.stringify(botBody), { status: botStatus }));
  try {
    const app = buildApp();
    const body = { event, metadata };
    const { status, text } = await post(app, body, sign(JSON.stringify(body)));
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    return {
      status,
      url: call ? String(call[0]) : null,
      body: call ? (JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>) : null,
      response: text,
    };
  } finally {
    fetchMock.mockRestore();
  }
}

const BACKUP_METADATA = {
  recordId: 'ckbackup0001',
  token: 'signed-download-token',
  chatId: '-1001234567890',
  topicThreadId: 42,
  filename: 'reiwa-2026-08-06.sql.gz',
  caption: '<b>Backup</b>',
} as const;

describe('Rezeis webhook relay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('relays a full error report to the exact operator topic', async () => {
    const { status, url, body } = await relay('reiwa.channel.broadcast.document', {
      eventId: 'sysevt:reiwa.error:2026-07-24T18:33:24.848Z:error-report',
      chatId: '-1001234567890',
      topicThreadId: 77,
      filename: 'error_20260724.txt',
      content: 'full error report',
      caption: '<b>Error</b>',
      parseMode: 'HTML',
    });

    expect(status).toBe(204);
    expect(url).toBe('http://reiwa-bot:5100/notify-broadcast-document');
    expect(body).toMatchObject({
      eventId: 'sysevt:reiwa.error:2026-07-24T18:33:24.848Z:error-report',
      chatId: '-1001234567890',
      topicThreadId: 77,
      filename: 'error_20260724.txt',
      content: 'full error report',
      caption: '<b>Error</b>',
    });
  });

  // ── notify button contract ────────────────────────────────────────────────
  // These are the shapes rezeis actually sends (promo web_app buttons, template
  // buttons with callback/style/row). Each MUST relay, not 400.

  it('relays a promo web_app button (webAppPath) instead of rejecting it', async () => {
    const { status, url, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-1',
        telegramId: '123456789',
        text: 'Промо внутри!',
        buttons: [{ text: 'Открыть', webAppPath: '/promo?code=SUMMER' }],
      },
      200,
      { messageId: 42 },
    );

    expect(status).toBe(200);
    expect(url).toBe('http://reiwa-bot:5100/notify');
    expect(body?.buttons).toEqual([{ text: 'Открыть', webAppPath: '/promo?code=SUMMER' }]);
  });

  it('relays a callback button with style and row', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-2',
        telegramId: '123456789',
        text: 'Выберите действие',
        buttons: [
          { text: 'Да', callbackData: 'confirm:yes', style: 'success', row: 0 },
          { text: 'Нет', callbackData: 'confirm:no', style: 'danger', row: 0 },
        ],
      },
      200,
      { messageId: 7 },
    );

    expect(status).toBe(200);
    expect(body?.buttons).toEqual([
      { text: 'Да', callbackData: 'confirm:yes', style: 'success', row: 0 },
      { text: 'Нет', callbackData: 'confirm:no', style: 'danger', row: 0 },
    ]);
  });

  it('still accepts a plain https url button', async () => {
    const { status } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-3',
        telegramId: '123456789',
        text: 'Ссылка',
        buttons: [{ text: 'Сайт', url: 'https://example.com/x' }],
      },
      200,
      { messageId: 1 },
    );
    expect(status).toBe(200);
  });

  it('drops a non-https url button but still delivers the message', async () => {
    // A decoration must never cost the message. The bot drops unusable buttons
    // one by one; the webhook now matches that instead of 400-ing everything.
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-4',
        telegramId: '123456789',
        text: 'важный текст',
        buttons: [
          { text: 'bad', url: 'http://insecure.example' },
          { text: 'good', url: 'https://example.com/ok' },
        ],
      },
      200,
      { messageId: 11 },
    );
    expect(status).toBe(200);
    expect(body?.text).toBe('важный текст');
    // Only the safe button survives — the http:// one never reaches the bot.
    expect(body?.buttons).toEqual([{ text: 'good', url: 'https://example.com/ok' }]);
  });

  it('omits the buttons key entirely when every button is unusable', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-4b',
        telegramId: '123456789',
        text: 'text survives',
        buttons: [{ text: 'bad', url: 'http://insecure.example' }],
      },
      200,
      { messageId: 12 },
    );
    expect(status).toBe(200);
    expect(body?.text).toBe('text survives');
    expect(body?.buttons).toBeUndefined();
  });

  it('relays a misconfigured absolute-URL webAppPath (bot neutralizes it, message not lost)', async () => {
    // reiwa defers to the bot, which anchors the path to its miniAppUrl and
    // re-validates — a bad path drops just that button, never the whole message.
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-5',
        telegramId: '123456789',
        text: 'still delivered',
        buttons: [{ text: 'weird', webAppPath: 'https://evil.example/promo' }],
      },
      200,
      { messageId: 3 },
    );
    expect(status).toBe(200);
    expect(body?.text).toBe('still delivered');
  });

  // ── banner contract ───────────────────────────────────────────────────────

  it('relays a relative /uploads banner instead of rejecting it', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-6',
        telegramId: '123456789',
        text: 'C баннером',
        bannerUrl: '/uploads/bot-banners/summer-2026.jpg',
      },
      200,
      { messageId: 5 },
    );
    expect(status).toBe(200);
    expect(body?.bannerUrl).toBe('/uploads/bot-banners/summer-2026.jpg');
  });

  it('relays a Telegram file_id banner', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-7',
        telegramId: '123456789',
        text: 'file_id баннер',
        bannerUrl: 'AgACAgIAAxkBAAEBftpk',
      },
      200,
      { messageId: 6 },
    );
    expect(status).toBe(200);
    expect(body?.bannerUrl).toBe('AgACAgIAAxkBAAEBftpk');
  });

  it('strips a path-traversal banner without letting it reach the bot', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-7a',
        telegramId: '123456789',
        text: 'text survives',
        bannerUrl: '/uploads/bot-banners/../../etc/passwd',
      },
      200,
      { messageId: 13 },
    );
    // The traversal value is gone; the notification itself is not collateral.
    expect(status).toBe(200);
    expect(body?.bannerUrl).toBeUndefined();
    expect(body?.text).toBe('text survives');
  });

  it('strips a banner outside the allow-listed upload subdirs', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-7b',
        telegramId: '123456789',
        text: 'text survives',
        bannerUrl: '/uploads/imports/secret.jpg',
      },
      200,
      { messageId: 14 },
    );
    expect(status).toBe(200);
    expect(body?.bannerUrl).toBeUndefined();
  });

  it('ignores an unknown metadata key instead of rejecting the event', async () => {
    // rezeis and reiwa deploy separately: a field added on the admin side must
    // not 400 the whole event until this service catches up.
    const { status, body } = await relay(
      'reiwa.user.notify',
      {
        eventId: 'evt-7c',
        telegramId: '123456789',
        text: 'forward compatible',
        somethingRezeisAddedLater: { nested: true },
      },
      200,
      { messageId: 15 },
    );
    expect(status).toBe(200);
    expect(body?.text).toBe('forward compatible')
    expect(body?.somethingRezeisAddedLater).toBeUndefined();
  });

  // ── text + caption edges ──────────────────────────────────────────────────

  it('forwards a single-space text placeholder instead of 400-ing a banner notification', async () => {
    const { status, body } = await relay(
      'reiwa.user.notify',
      { eventId: 'evt-8', telegramId: '123456789', text: ' ' },
      200,
      { messageId: 8 },
    );
    expect(status).toBe(200);
    expect(body?.text).toBe(' ');
  });

  it('drops an over-long HTML caption but still delivers the document', async () => {
    // Captions are HTML, and the 1024 limit counts RENDERED characters. Slicing
    // the markup would cut a tag in half, Telegram would reject the whole send
    // as unparseable, and the bot reports that as a permanent 4xx — i.e. the
    // report would vanish silently. The full text is in the document body, so
    // dropping just the preview caption is the lossless choice.
    const longCaption = `<blockquote>${'a'.repeat(2000)}</blockquote>`;
    const { status, body } = await relay('reiwa.channel.broadcast.document', {
      eventId: 'evt-9',
      chatId: '-1001234567890',
      content: 'report',
      caption: longCaption,
    });
    expect(status).toBe(204);
    expect(body?.caption).toBeUndefined();
    expect(body?.content).toBe('report');
  });

  it('keeps a caption that fits', async () => {
    const { status, body } = await relay('reiwa.channel.broadcast.document', {
      eventId: 'evt-9b',
      chatId: '-1001234567890',
      content: 'report',
      caption: '<b>Error</b> summary',
    });
    expect(status).toBe(204);
    expect(body?.caption).toBe('<b>Error</b> summary');
  });

  // ── channel chat id ───────────────────────────────────────────────────────

  it('accepts an @username channel target for a broadcast', async () => {
    const { status, body } = await relay('reiwa.channel.broadcast', {
      eventId: 'evt-10',
      chatId: '@my_channel',
      text: 'Всем привет',
      buttons: [{ text: 'Промо', webAppPath: '/promo?code=X' }],
    });
    expect(status).toBe(204);
    expect(body?.chatId).toBe('@my_channel');
    expect(body?.buttons).toEqual([{ text: 'Промо', webAppPath: '/promo?code=X' }]);
  });

  // ── backup relay: the message id is the delivery receipt ───────────────────
  //
  // A 2xx from this webhook only proves the relay INSTRUCTION was accepted —
  // the bot fetches the file from rezeis and uploads it afterwards. Telegram's
  // message id, echoed back through here, is the only evidence in the exchange
  // that the backup actually left the machine. rezeis records a backup as
  // delivered off-site strictly on a numeric `messageId` and classifies a 2xx
  // without one as `unconfirmed` — a NON-retryable failure. So dropping the id
  // here does not degrade gracefully: it marks every backup, on every cycle,
  // as never delivered, and no retry can ever correct it.

  it('echoes the Telegram message id for a delivered backup', async () => {
    const { status, url, body, response } = await relay(
      'reiwa.backup.document',
      { ...BACKUP_METADATA },
      200,
      { messageId: 4242 },
    );

    expect(url).toBe('http://reiwa-bot:5100/notify-backup-document');
    expect(body).toMatchObject({
      recordId: 'ckbackup0001',
      token: 'signed-download-token',
      chatId: '-1001234567890',
      topicThreadId: 42,
      filename: 'reiwa-2026-08-06.sql.gz',
      caption: '<b>Backup</b>',
    });
    // This pair IS rezeis's `confirmed` bar: 2xx + a numeric messageId in the
    // body. Anything else there is recorded as an undelivered backup.
    expect(status).toBe(200);
    expect(JSON.parse(response)).toEqual({ messageId: 4242 });
    expect(typeof (JSON.parse(response) as { messageId: unknown }).messageId).toBe('number');
  });

  it('reports no id — never a fake one — when the bot could not prove delivery', async () => {
    // Bot answered 204: upload never happened, or happened unprovably (no bot
    // token, download failed, sendDocument threw). Must NOT invent an id: that
    // would stamp a backup that is only on the local disk as safely off-site,
    // and retention prunes local copies it believes are duplicated.
    const { status, response } = await relay('reiwa.backup.document', { ...BACKUP_METADATA }, 204);

    expect(status).toBe(200);
    expect(JSON.parse(response)).toEqual({ messageId: null });
  });

  it('still fails loudly when the bot relay itself fails', async () => {
    // A bot 5xx is transient — rezeis must see a 502 and retry, not a 2xx that
    // it would file as "accepted, unconfirmed" and never try again.
    const { status, response } = await relay('reiwa.backup.document', { ...BACKUP_METADATA }, 503);

    expect(status).toBe(502);
    expect(response).not.toContain('messageId');
  });

  it('leaves the other relay kinds on their bodiless 204 ack', async () => {
    // The backup case returns early; the shared fall-through must be untouched,
    // including when the bot happens to answer 200 with a body.
    const broadcast = await relay(
      'reiwa.channel.broadcast.document',
      { eventId: 'evt-11', chatId: '-1001234567890', content: 'report' },
      200,
      { messageId: 4242 },
    );
    expect(broadcast.status).toBe(204);
    expect(broadcast.response).toBe('');

    const invalidate = await relay('reiwa.bot.invalidate', { reason: 'test' });
    expect(invalidate.status).toBe(204);
    expect(invalidate.response).toBe('');
  });
});
