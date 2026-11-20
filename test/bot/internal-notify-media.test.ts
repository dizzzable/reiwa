/**
 * Media broadcasts through the relay: `/notify` and `/notify-broadcast` with a
 * `media { type, fileId }` field.
 *
 * The panel composes the caption (HTML with `<tg-emoji>` premium emoji) and
 * holds a Telegram `file_id` minted by its own upload; the bot renders the
 * caption and sends `sendPhoto`/`sendVideo`. Two contracts this file pins:
 *
 *   • the media send NEVER degrades to a text-only post — unlike a banner, the
 *     image is the delivery, so a Telegram refusal surfaces as a 422 the panel
 *     records FAILED with, and 403 (the bot was blocked) takes the same
 *     blocked path a text notification takes;
 *   • a malformed `media` field is a loud 400, not a quiet drop to the caption
 *     alone — the panel would record a text-only post as SENT.
 *
 * Driven through the real listener on a socket with real internal-HMAC headers,
 * against a bot whose api RECORDS what it is asked to send.
 */
import http from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';

import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';
import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';

const SECRET = 's'.repeat(32);
const CHAT_ID = '987000111';
const CHANNEL_ID = '-1001234567890';
const PHOTO_FILE_ID = 'AgACAgIAAxkBAAEBftpk-photo';
const VIDEO_FILE_ID = 'BAACAgIAAxkBAAEBftpk-video';

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

let idCounter = 0;
function freshEventId(label: string): string {
  idCounter += 1;
  return `media:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

interface SendResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

interface Harness {
  readonly call: (path: string, body: Record<string, unknown>) => Promise<SendResult>;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly sendPhoto: ReturnType<typeof vi.fn>;
  readonly sendVideo: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

const running: Harness[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

function start(opts: Partial<ListenerOptions> = {}): Harness {
  const sendMessage = vi.fn(async () => ({ message_id: 11 }));
  const sendPhoto = vi.fn(async () => ({ message_id: 21 }));
  const sendVideo = vi.fn(async () => ({ message_id: 22 }));
  const bot = { api: { sendMessage, sendPhoto, sendVideo } } as unknown as ListenerOptions['bot'];
  const cache = { get: async () => DEFAULT_BOT_CONFIG } as unknown as ListenerOptions['cache'];

  const server = startInternalHttpListener({
    bot,
    cache,
    secret: SECRET,
    port: 0,
    logger: silentLogger,
    devId: 555000222,
    keyboardUrls: { miniAppUrl: 'https://t.me/reiwa_demo_bot/app' },
    ...opts,
  });
  if (server === null) throw new Error('listener did not start');
  const ready = once(server, 'listening');

  const call = async (path: string, body: Record<string, unknown>): Promise<SendResult> => {
    await ready;
    const { port } = server.address() as { port: number };
    const raw = JSON.stringify(body);
    const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path, body: raw });
    return await new Promise<SendResult>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            connection: 'close',
            [REQUEST_TIMESTAMP_HEADER]: timestamp,
            [REQUEST_SIGNATURE_HEADER]: signature,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => {
            const body: Record<string, unknown> | null =
              text.length > 0 && res.headers['content-type']?.includes('application/json')
                ? (JSON.parse(text) as Record<string, unknown>)
                : null;
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
  };

  const close = async (): Promise<void> => {
    await ready;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const harness = { call, sendMessage, sendPhoto, sendVideo, close };
  running.push(harness);
  return harness;
}

const HTML_CAPTION = '<b>Заголовок</b>\n\nФото с <tg-emoji emoji-id="5368324170671202286">🎉</tg-emoji> эмодзи';
const MEDIA_PHOTO = { type: 'photo', fileId: PHOTO_FILE_ID } as const;
const MEDIA_VIDEO = { type: 'video', fileId: VIDEO_FILE_ID } as const;

/** A Bot API refusal exactly as grammY raises it. */
function telegramError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendPhoto' failed!",
    { ok: false, error_code: errorCode, description, parameters: {} },
    'sendPhoto',
    {},
  );
}

describe('bot /notify — a media broadcast', () => {
  it('sends the photo with the caption instead of a text message', async () => {
    const h = start();
    const { status, body } = await h.call('/notify', {
      eventId: freshEventId('photo'),
      telegramId: CHAT_ID,
      text: HTML_CAPTION,
      parseMode: 'HTML',
      media: MEDIA_PHOTO,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ messageId: 21 });
    expect(h.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, fileId, options] = h.sendPhoto.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(chatId).toBe(CHAT_ID);
    expect(fileId).toBe(PHOTO_FILE_ID);
    expect(options.caption).toBe(HTML_CAPTION);
    expect(options.parse_mode).toBe('HTML');
    expect(options.reply_markup).toBeUndefined();
    // The text-only send must not happen beside the photo.
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.sendVideo).not.toHaveBeenCalled();
  });

  it('sends a video with streaming enabled and the caption', async () => {
    const h = start();
    const { status, body } = await h.call('/notify', {
      eventId: freshEventId('video'),
      telegramId: CHAT_ID,
      text: '<b>Видео</b>',
      parseMode: 'HTML',
      media: MEDIA_VIDEO,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ messageId: 22 });
    expect(h.sendVideo).toHaveBeenCalledTimes(1);
    const [chatId, fileId, options] = h.sendVideo.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(chatId).toBe(CHAT_ID);
    expect(fileId).toBe(VIDEO_FILE_ID);
    expect(options.caption).toBe('<b>Видео</b>');
    expect(options.supports_streaming).toBe(true);
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('renders the relay buttons beside the media (a promo Mini App button included)', async () => {
    const h = start();
    await h.call('/notify', {
      eventId: freshEventId('buttons'),
      telegramId: CHAT_ID,
      text: '<b>Промо</b>',
      parseMode: 'HTML',
      buttons: [
        { text: '🎁 Активировать промокод', webAppPath: '/promo?code=SUMMER' },
        { text: '🏠 Главное меню', callbackData: 'menu:new' },
      ],
      media: MEDIA_PHOTO,
    });
    const [, , options] = h.sendPhoto.mock.calls[0] as [string, string, Record<string, unknown>];
    const keyboard = options.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> };
    expect(keyboard.inline_keyboard).toHaveLength(2);
    expect(keyboard.inline_keyboard[0][0]).toMatchObject({
      text: '🎁 Активировать промокод',
      // The path is anchored onto the bot's Mini App url — the deep link lands
      // on the promo page directly.
      web_app: { url: 'https://t.me/reiwa_demo_bot/app/promo?code=SUMMER' },
    });
    expect(keyboard.inline_keyboard[1][0]).toMatchObject({ text: '🏠 Главное меню', callback_data: 'menu:new' });
  });

  it('ignores a banner when media is present — media wins', async () => {
    const h = start();
    await h.call('/notify', {
      eventId: freshEventId('media-over-banner'),
      telegramId: CHAT_ID,
      text: '<b>Оба поля</b>',
      parseMode: 'HTML',
      bannerUrl: '/uploads/bot-banners/summer.jpg',
      media: MEDIA_PHOTO,
    });
    expect(h.sendPhoto).toHaveBeenCalledTimes(1);
    const [, fileId] = h.sendPhoto.mock.calls[0] as [string, string];
    // The broadcast's own file, not a banner fetched from rezeis.
    expect(fileId).toBe(PHOTO_FILE_ID);
  });

  it('answers 400 to a malformed media field and sends nothing', async () => {
    const h = start();
    const { status } = await h.call('/notify', {
      eventId: freshEventId('malformed'),
      telegramId: CHAT_ID,
      text: 'text alone must not win',
      media: { type: 'sticker', fileId: PHOTO_FILE_ID },
    });
    expect(status).toBe(400);
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('surfaces a Telegram refusal as 422 instead of falling back to the caption alone', async () => {
    const h = start();
    h.sendPhoto.mockRejectedValue(
      telegramError(400, 'Bad Request: CAPTION_TOO_LONG'),
    );
    const { status } = await h.call('/notify', {
      eventId: freshEventId('refused'),
      telegramId: CHAT_ID,
      text: '<b>Слишком длинная подпись</b>',
      parseMode: 'HTML',
      media: MEDIA_PHOTO,
    });
    expect(status).toBe(422);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('treats a 403 as the blocked-bot outcome, not a failure', async () => {
    const h = start();
    h.sendPhoto.mockRejectedValue(
      telegramError(403, 'Forbidden: bot was blocked by the user'),
    );
    const { status, body } = await h.call('/notify', {
      eventId: freshEventId('blocked'),
      telegramId: CHAT_ID,
      text: '<b>Пост</b>',
      parseMode: 'HTML',
      media: MEDIA_PHOTO,
    });
    expect(status).toBe(204);
    expect(body).toBeNull();
  });
});

describe('bot /notify-broadcast — the channel copy of a media broadcast', () => {
  it('posts the photo to the operator channel with the caption', async () => {
    const h = start();
    const { status, body } = await h.call('/notify-broadcast', {
      eventId: freshEventId('channel-photo'),
      chatId: CHANNEL_ID,
      text: HTML_CAPTION,
      parseMode: 'HTML',
      media: MEDIA_PHOTO,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ messageId: 21 });
    expect(h.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, fileId, options] = h.sendPhoto.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(chatId).toBe(CHANNEL_ID);
    expect(fileId).toBe(PHOTO_FILE_ID);
    expect(options.caption).toBe(HTML_CAPTION);
    expect(options.parse_mode).toBe('HTML');
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('posts a video into a forum topic with streaming enabled', async () => {
    const h = start();
    const { status } = await h.call('/notify-broadcast', {
      eventId: freshEventId('channel-video'),
      chatId: CHANNEL_ID,
      text: '<b>Видео</b>',
      parseMode: 'HTML',
      topicThreadId: 42,
      media: MEDIA_VIDEO,
    });
    expect(status).toBe(200);
    const [chatId, fileId, options] = h.sendVideo.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(chatId).toBe(CHANNEL_ID);
    expect(fileId).toBe(VIDEO_FILE_ID);
    expect(options.message_thread_id).toBe(42);
    expect(options.supports_streaming).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('answers 400 to a malformed media field and posts nothing', async () => {
    const h = start();
    const { status } = await h.call('/notify-broadcast', {
      eventId: freshEventId('channel-malformed'),
      chatId: CHANNEL_ID,
      text: 'text',
      media: { type: 'photo' },
    });
    expect(status).toBe(400);
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('still posts a text-only broadcast exactly as before', async () => {
    const h = start();
    const { status, body } = await h.call('/notify-broadcast', {
      eventId: freshEventId('channel-text'),
      chatId: CHANNEL_ID,
      text: '<b>Только текст</b>',
      parseMode: 'HTML',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ messageId: 11 });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendVideo).not.toHaveBeenCalled();
  });
});
