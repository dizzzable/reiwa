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
 * The genuine `AbortSignal.timeout`, captured before any spy replaces it.
 *
 * A total deadline cannot be read back OFF an `AbortSignal` — the object does
 * not carry the ms it was minted with, and `signal` was therefore the one part
 * of the relay call this file used to drop on the floor. The deadline
 * assertions below read the budget off the MINT instead: `relay` spies on
 * `AbortSignal.timeout`, records what the router asked for, and hands back a
 * real signal produced by this function, so a deadline can still actually fire.
 *
 * Vitest's fake timers are no lever here. `AbortSignal.timeout` schedules on
 * libuv's own timer rather than the `setTimeout` the fake clock patches, so
 * `vi.advanceTimersByTime` never reaches it — the mint is the only thing that
 * can be shortened, and `relayAgainstWedgedBot` below is where that is done.
 */
const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal);

/** What one relay asked of `AbortSignal.timeout`, and what reached `fetch`. */
interface RelayDeadline {
  /** Every ms handed to `AbortSignal.timeout` during the relay, in order. */
  readonly requestedMs: readonly number[];
  /** The signals those calls produced, in the same order. */
  readonly minted: readonly AbortSignal[];
  /** Whether the fetch init carried a `signal` key at all. */
  readonly attached: boolean;
  /** The value under that key — `undefined` when the router set none. */
  readonly signal: AbortSignal | null | undefined;
}

/**
 * Post a `{ event, metadata }` webhook, capturing the payload the router
 * relays to the bot. Returns the HTTP status plus the relayed path + body so a
 * test can assert both that the webhook accepted the payload (not 400) and that
 * it forwarded the exact contract the bot expects. `response` is what the
 * webhook itself answered with — the half rezeis reads back.
 *
 * `deadline` is the third part of that call: which total budget the router
 * minted, and whether the resulting signal is the one it handed to `fetch`.
 * Minting the right number and then not attaching it is as broken as minting
 * the wrong one, so both halves are reported rather than only the first.
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
  deadline: RelayDeadline;
}> {
  const requestedMs: number[] = [];
  const minted: AbortSignal[] = [];
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    requestedMs.push(ms);
    // Real signal, real duration: this helper only WATCHES the mint, so a test
    // that asserts on the relayed body behaves exactly as it did before.
    const signal = realAbortTimeout(ms);
    minted.push(signal);
    return signal;
  });
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(botBody === null ? null : JSON.stringify(botBody), { status: botStatus }));
  try {
    const app = buildApp();
    const body = { event, metadata };
    const { status, text } = await post(app, body, sign(JSON.stringify(body)));
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    const init = call ? (call[1] as RequestInit) : undefined;
    return {
      status,
      url: call ? String(call[0]) : null,
      body: call ? (JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>) : null,
      response: text,
      deadline: {
        requestedMs,
        minted,
        attached: init !== undefined && Object.hasOwn(init, 'signal'),
        signal: init?.signal,
      },
    };
  } finally {
    fetchMock.mockRestore();
    timeoutSpy.mockRestore();
  }
}

/** How long the shortened fuse burns for in `relayAgainstWedgedBot`. */
const FAST_DEADLINE_MS = 25;
/** How long that helper waits for an answer before calling the relay wedged. */
const WEDGED_WINDOW_MS = 400;

/**
 * Post one webhook at a bot that never answers, and report what the webhook did
 * within `WEDGED_WINDOW_MS` — a status if a deadline cut the call short, `null`
 * if the handler is still holding.
 *
 * The `fetch` stub honours an `AbortSignal` the way undici does (reject with the
 * signal's reason on abort) and otherwise NEVER settles, so the only thing that
 * can end one of these calls is a deadline the router attached itself.
 *
 * `AbortSignal.timeout` is re-pointed at `FAST_DEADLINE_MS` for the duration.
 * Fake timers cannot advance the real one (see `realAbortTimeout` above) and no
 * spec may sit out the genuine 8s/30s budgets. The router still asks for its own
 * numbers — `requestedMs` reports them, and the mint assertions above pin them —
 * this only shortens the fuse so the firing itself is observable.
 */
async function relayAgainstWedgedBot(
  event: string,
  metadata: Record<string, unknown>,
): Promise<{ status: number | null; requestedMs: readonly number[] }> {
  const requestedMs: number[] = [];
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    requestedMs.push(ms);
    return realAbortTimeout(FAST_DEADLINE_MS);
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      // No signal — the wedged bot holds the handler for as long as the far end
      // stays silent, which is precisely what an absent total deadline means.
      if (signal === undefined || signal === null) return;
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
  });

  const server = http.createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const raw = JSON.stringify({ event, metadata });
  let settle!: (value: number | null) => void;
  const answered = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const giveUp = setTimeout(() => settle(null), WEDGED_WINDOW_MS);
  // `agent: false` + `connection: close` keep the socket from lingering so the
  // teardown below settles even while the handler is still stuck.
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/v1/webhooks/rezeis',
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        connection: 'close',
        'x-rezeis-signature': sign(raw),
      },
    },
    (res) => {
      res.resume();
      settle(res.statusCode ?? 0);
    },
  );
  // The give-up `destroy()` below lands here; by then `answered` has settled.
  req.on('error', () => settle(null));
  req.end(raw);
  try {
    return { status: await answered, requestedMs };
  } finally {
    clearTimeout(giveUp);
    req.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fetchMock.mockRestore();
    timeoutSpy.mockRestore();
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

  // ── dev fallback: the dedup key rezeis may or may not have ────────────────
  //
  // `reiwa.dev.notify` / `reiwa.dev.notify.document` are the firehose that only
  // matters while something is already broken, and rezeis now relays them off a
  // BullMQ queue with 4 attempts (15s/30s/60s). So this webhook has to satisfy
  // two rules at once: forward the `eventId` the bot dedups on when the panel
  // sends one, and never turn its absence into a rejection — a panel older than
  // the field sends `{ text, parseMode }` and nothing else, and a 400 there
  // loses the only notice anyone gets about the outage.

  it('forwards the dedup key on a dev card so the bot can suppress the retry', async () => {
    const { status, url, body } = await relay('reiwa.dev.notify', {
      eventId: 'sysevt:reiwa.error:2026-08-18T09:00:00.000Z',
      text: '<b>Сбой</b> очереди',
      parseMode: 'HTML',
    });

    expect(status).toBe(204);
    expect(url).toBe('http://reiwa-bot:5100/notify-dev');
    expect(body).toMatchObject({
      eventId: 'sysevt:reiwa.error:2026-08-18T09:00:00.000Z',
      text: '<b>Сбой</b> очереди',
      parseMode: 'HTML',
    });
  });

  it('forwards the dedup key on a dev error report', async () => {
    const { status, url, body } = await relay('reiwa.dev.notify.document', {
      eventId: 'sysevt:reiwa.error:2026-08-18T09:00:00.000Z:error-report',
      content: 'full error report',
      filename: 'error_0.txt',
      caption: '<b>Сбой</b>',
    });

    expect(status).toBe(204);
    expect(url).toBe('http://reiwa-bot:5100/notify-dev-document');
    expect(body).toMatchObject({
      eventId: 'sysevt:reiwa.error:2026-08-18T09:00:00.000Z:error-report',
      content: 'full error report',
      filename: 'error_0.txt',
    });
  });

  it('still relays a dev card from a panel that sends no eventId', async () => {
    // The shape every shipped panel sends today. Must relay, not 400.
    const { status, url, body } = await relay('reiwa.dev.notify', { text: 'старая панель' });

    expect(status).toBe(204);
    expect(url).toBe('http://reiwa-bot:5100/notify-dev');
    expect(body).toEqual({ text: 'старая панель' });
    // Absent, not `undefined`/`null` — the bot distinguishes "no key" (deliver,
    // no dedup) from a key it should claim, and a null would have to be special
    // -cased on the far side.
    expect(Object.hasOwn(body ?? {}, 'eventId')).toBe(false);
  });

  it('still relays a dev error report from a panel that sends no eventId', async () => {
    const { status, url, body } = await relay('reiwa.dev.notify.document', {
      content: 'full error report',
      filename: 'error_0.txt',
    });

    expect(status).toBe(204);
    expect(url).toBe('http://reiwa-bot:5100/notify-dev-document');
    expect(Object.hasOwn(body ?? {}, 'eventId')).toBe(false);
    expect(body?.content).toBe('full error report');
  });

  it('drops an unusable dev eventId instead of dropping the alert', async () => {
    // A key that fails the shape check degrades this event to "delivered, not
    // deduped" — one card the operator glances past. Rejecting it would lose
    // the alert, which is the one outcome this event cannot afford.
    const { status, body } = await relay('reiwa.dev.notify', {
      eventId: 'x'.repeat(400),
      text: 'важное',
    });

    expect(status).toBe(204);
    expect(Object.hasOwn(body ?? {}, 'eventId')).toBe(false);
    expect(body?.text).toBe('важное');
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

/**
 * The relay deadline — the one part of the outbound call nothing used to watch.
 *
 * Two opposite mistakes live here, and they are the SAME edit seen from either
 * side. Drop the budget from the message relays and a wedged bot pins an express
 * handler on undici's 300s default, long after rezeis stopped waiting for the
 * answer being held. Put one on `/notify-backup-document` and a legitimately
 * slow multi-gigabyte upload gets cut mid-flight; the abort surfaces as a 502,
 * which is the single signal `BackupService` DOES retry (BullMQ `attempts: 3`),
 * so one slow backup becomes two or three copies of the same gigabytes in the
 * operator's topic.
 *
 * Both were provably invisible: swapping the two — no deadline on messages, the
 * document deadline on the backup — left every spec in this file and in
 * `test/bot/internal-backup-relay.test.ts` green, because the fetch spy read
 * only the URL and the body.
 *
 * The numbers themselves (8s / 30s) are asserted as literals rather than
 * imported from the router: importing them would let the constants and the
 * assertions drift together and still agree, which is how this hole opened.
 */
describe('Bot relay deadlines', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Relays that produce a Telegram MESSAGE — bounded by the 8s budget. */
  const MESSAGE_RELAYS = [
    { path: '/invalidate', event: 'reiwa.bot.invalidate', metadata: { reason: 'test' } },
    {
      path: '/notify',
      event: 'reiwa.user.notify',
      metadata: { eventId: 'dl-1', telegramId: '123456789', text: 'сообщение' },
    },
    { path: '/notify-dev', event: 'reiwa.dev.notify', metadata: { text: 'алерт' } },
    {
      path: '/notify-broadcast',
      event: 'reiwa.channel.broadcast',
      metadata: { eventId: 'dl-2', chatId: '-1001234567890', text: 'всем' },
    },
  ] as const;

  /** Relays that carry INLINE document bytes — bounded by the 30s budget. */
  const DOCUMENT_RELAYS = [
    {
      path: '/notify-dev-document',
      event: 'reiwa.dev.notify.document',
      metadata: { content: 'full error report', filename: 'error_0.txt' },
    },
    {
      path: '/notify-broadcast-document',
      event: 'reiwa.channel.broadcast.document',
      metadata: { eventId: 'dl-3', chatId: '-1001234567890', content: 'full error report' },
    },
  ] as const;

  it('bounds every message relay at the 8s budget', async () => {
    for (const { path, event, metadata } of MESSAGE_RELAYS) {
      const { status, url, deadline } = await relay(event, metadata);

      // Self-check: without this a route that 400'd before ever reaching the
      // relay would satisfy an "attached nothing wrong" reading for free.
      expect(url, path).toBe(`http://reiwa-bot:5100${path}`);
      expect(status, path).toBeLessThan(400);
      expect(deadline.requestedMs, path).toEqual([8_000]);
      // Minted AND attached. A budget computed and then left off the request is
      // no budget at all, and the two are separate edits.
      expect(deadline.attached, path).toBe(true);
      expect(deadline.signal, path).toBe(deadline.minted[0]);
    }
  });

  it('gives the document relays the wider 30s budget instead', async () => {
    for (const { path, event, metadata } of DOCUMENT_RELAYS) {
      const { status, url, deadline } = await relay(event, metadata);

      expect(url, path).toBe(`http://reiwa-bot:5100${path}`);
      expect(status, path).toBeLessThan(400);
      // The message budget is too tight here: the bot uploads these bytes to
      // Telegram before it answers. Asserting the exact value, not merely
      // "larger than a message", so a silent fall back to the 8s default fails.
      expect(deadline.requestedMs, path).toEqual([30_000]);
      expect(deadline.attached, path).toBe(true);
      expect(deadline.signal, path).toBe(deadline.minted[0]);
    }
  });

  it('sends the backup relay with NO total deadline at all', async () => {
    const { status, url, deadline } = await relay(
      'reiwa.backup.document',
      { ...BACKUP_METADATA },
      200,
      { messageId: 4242 },
    );

    expect(url).toBe('http://reiwa-bot:5100/notify-backup-document');
    expect(status).toBe(200);
    // ABSENCE, asserted three ways rather than as "some value":
    // 1. no total deadline was minted at all during this relay…
    expect(deadline.requestedMs).toEqual([]);
    // 2. …the request carried no `signal` key…
    expect(deadline.attached).toBe(false);
    // 3. …and nothing arrived under it by another route (an AbortController's
    //    signal would pass 1 and 2's spirit but not this).
    expect(deadline.signal).toBeUndefined();
  });

  // ── the budget has to FIRE, not merely be attached ─────────────────────────
  //
  // Everything above proves a signal with the right duration reaches `fetch`.
  // None of it proves the call actually ends: an already-aborted signal, or one
  // whose fuse never burns, would satisfy all of it. These two drive the router
  // against a bot that never answers and watch which calls come back.

  it('cuts a wedged bot off instead of holding the handler open', async () => {
    for (const { label, event, metadata, expectedMs } of [
      {
        label: 'message relay',
        event: 'reiwa.user.notify',
        metadata: { eventId: 'dl-9', telegramId: '123456789', text: 'сообщение' },
        expectedMs: 8_000,
      },
      {
        label: 'document relay',
        event: 'reiwa.channel.broadcast.document',
        metadata: { eventId: 'dl-10', chatId: '-1001234567890', content: 'report' },
        expectedMs: 30_000,
      },
    ]) {
      const { status, requestedMs } = await relayAgainstWedgedBot(event, metadata);

      // The stub never resolves, so nothing but the router's own deadline can
      // end this call — and it asked for its real budget before the fuse was
      // shortened, which keeps this test honest about what it exercised.
      expect(requestedMs, label).toEqual([expectedMs]);
      // 502 = transient, the answer rezeis is waiting on. `null` here means the
      // handler is still held — the five-minute undici default, unbounded.
      expect(status, label).toBe(502);
    }
  });

  it('lets a slow backup upload outrun every message budget', async () => {
    // The mirror of the test above, and the reason `/notify-backup-document`
    // passes `null`: with the fuse shortened to 25ms, ANY total deadline on this
    // path would have fired long before the window closes and answered 502 —
    // the one status BackupService retries, i.e. a second copy of the same
    // gigabytes. Still pending is the correct outcome.
    const { status, requestedMs } = await relayAgainstWedgedBot('reiwa.backup.document', {
      ...BACKUP_METADATA,
    });

    expect(requestedMs).toEqual([]);
    expect(status).toBeNull();
  });
});
