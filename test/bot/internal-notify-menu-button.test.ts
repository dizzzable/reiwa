/**
 * «Главное меню» under a pushed message — a notification, a broadcast post —
 * opens the menu as a NEW message (the owner, 15.10.2026). `menu:main`, and
 * `menu` as an operator types it, drew the menu in place of the message they
 * were pressed under, so the post the subscriber was reading was gone. The
 * listener draws both as `menu:new` now; every other button is drawn as it came.
 *
 * Driven through the real listener on a socket with real internal-HMAC headers,
 * against a bot whose api RECORDS what it is asked to send.
 */
import http from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';
import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import { MENU_ANEW_CALLBACK, pushedCallbackData } from '../../src/bot/lib/menu-anew.js';
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';

const SECRET = 's'.repeat(32);

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
  return `menu:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function notify(path: string, body: Record<string, unknown>): Promise<{ status: number; sendMessage: ReturnType<typeof vi.fn> }> {
  const sendMessage = vi.fn(async () => ({ message_id: 11 }));
  const bot = { api: { sendMessage } } as unknown as ListenerOptions['bot'];
  const cache = { get: async () => DEFAULT_BOT_CONFIG } as unknown as ListenerOptions['cache'];
  const server = startInternalHttpListener({ bot, cache, secret: SECRET, port: 0, logger: silentLogger, devId: 1 });
  if (server === null) throw new Error('listener did not start');
  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const raw = JSON.stringify(body);
  const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path, body: raw });
  const status = await new Promise<number>((resolve, reject) => {
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
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
  return { status, sendMessage };
}

/** The callback data of every button of the first message sent, row by row. */
function callbackDataOf(sendMessage: ReturnType<typeof vi.fn>): unknown[][] {
  const [, , options] = sendMessage.mock.calls[0] as [unknown, string, Record<string, unknown> | undefined];
  const markup = options?.['reply_markup'] as { inline_keyboard: Array<Array<Record<string, unknown>>> } | undefined;
  return (markup?.inline_keyboard ?? []).map((row) => row.map((button) => button['callback_data']));
}

describe('«Главное меню» under a pushed message', () => {
  it('a notification draws `menu:main` and `menu` as `menu:new`, and leaves every other button as it came', async () => {
    const { status, sendMessage } = await notify('/notify', {
      eventId: freshEventId('notify'),
      telegramId: '42',
      text: 'Подписка истекает через 3 дня',
      buttons: [
        { text: '🏠 Главное меню', callbackData: 'menu:main' },
        { text: 'Меню', callbackData: 'menu' },
        { text: 'Помощь', callbackData: 'help' },
      ],
    });

    expect(status).toBe(200);
    expect(callbackDataOf(sendMessage)).toEqual([[MENU_ANEW_CALLBACK], [MENU_ANEW_CALLBACK], ['help']]);
  });

  it('a broadcast post that already asks for `menu:new` keeps it', async () => {
    const { sendMessage } = await notify('/notify', {
      eventId: freshEventId('broadcast'),
      telegramId: '42',
      text: 'Новости',
      buttons: [{ text: '🏠 Главное меню', callbackData: MENU_ANEW_CALLBACK }],
    });

    expect(callbackDataOf(sendMessage)).toEqual([[MENU_ANEW_CALLBACK]]);
  });

  it('the mapping: the two spellings of the main menu, and nothing else', () => {
    expect(pushedCallbackData('menu:main')).toBe('menu:new');
    expect(pushedCallbackData('menu')).toBe('menu:new');
    expect(pushedCallbackData('menu:new')).toBe('menu:new');
    for (const data of ['help', 'invite', 'screen:promo', 'menu:mainx', 'menus', 'back_to_menu']) {
      expect(pushedCallbackData(data)).toBe(data);
    }
  });
});
