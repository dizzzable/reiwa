/**
 * The operator's emoji tokens in what the panel relays through this listener.
 *
 * Two defects, one per half of the listener:
 *
 *   • `/notify-dev`, `/notify-dev-document` and `/notify-broadcast-document`
 *     sent the panel's text as it came. The panel builds those operator cards
 *     itself and does not resolve pack emoji in them (only its broadcasts and
 *     user notifications go through its `CustomEmojiService`), so a `:slug:` in
 *     a plan's or a user's name reached the operator as the token.
 *   • `/notify` and `/notify-broadcast` resolved tokens, but a MarkdownV2 body
 *     with a premium pack emoji was sent as custom-emoji ENTITIES — which
 *     cannot travel with a parse mode — so the parse mode was dropped and the
 *     reader got the operator's markup raw: `*bold*`, and every `\.` escape.
 *     MarkdownV2 has its own custom-emoji syntax, `![🔥](tg://emoji?id=…)`
 *     (TDLib `parse_markdown_v2`), and uses it now; the parse mode stays.
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
import { DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../src/infrastructure/bot-config/types.js';

const SECRET = 's'.repeat(32);
const DEV_ID = 555000222;
const FIRE_ID = '5368324170671202286';
const SPARK_ID = '5203996991054432397';

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

/** The pack: `:fire:` and `:spark_one:` with ids, `:keycap:` a glyph with a MarkdownV2-reserved `#`. */
function packConfig(ownerHasPremium: boolean): BotConfig {
  return {
    ...DEFAULT_BOT_CONFIG,
    customEmojis: {
      fire: { id: FIRE_ID, fallback: '🔥' },
      spark_one: { id: SPARK_ID, fallback: '✨' },
      keycap: { id: null, fallback: '#️⃣' },
    },
    botEmojiOwnerHasPremium: ownerHasPremium,
  };
}

let idCounter = 0;
function freshEventId(label: string): string {
  idCounter += 1;
  return `emoji:${label}:${process.pid}:${Date.now()}:${idCounter}`;
}

interface Harness {
  readonly call: (path: string, body: Record<string, unknown>) => Promise<number>;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly sendDocument: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

const running: Harness[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

function start(config: BotConfig): Harness {
  const sendMessage = vi.fn(async () => ({ message_id: 11 }));
  const sendDocument = vi.fn(async () => ({ message_id: 12 }));
  const bot = { api: { sendMessage, sendDocument } } as unknown as ListenerOptions['bot'];
  const cache = { get: async () => config } as unknown as ListenerOptions['cache'];

  const server = startInternalHttpListener({ bot, cache, secret: SECRET, port: 0, logger: silentLogger, devId: DEV_ID });
  if (server === null) throw new Error('listener did not start');
  const ready = once(server, 'listening');

  const call = async (path: string, body: Record<string, unknown>): Promise<number> => {
    await ready;
    const { port } = server.address() as { port: number };
    const raw = JSON.stringify(body);
    const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path, body: raw });
    return await new Promise<number>((resolve, reject) => {
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
  };

  const close = async (): Promise<void> => {
    await ready;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const harness = { call, sendMessage, sendDocument, close };
  running.push(harness);
  return harness;
}

/** The text and options of the `index`-th `sendMessage(chatId, text, options)`. */
function sentText(sendMessage: ReturnType<typeof vi.fn>, index = 0): { text: string; options: Record<string, unknown> } {
  const [, text, options] = sendMessage.mock.calls[index] as [unknown, string, Record<string, unknown> | undefined];
  return { text, options: options ?? {} };
}

const HTML_CARD = '<b>Новый платёж</b>\nТариф: :fire: Премиум {{GIFT}}';
const HTML_RESOLVED = `<b>Новый платёж</b>\nТариф: <tg-emoji emoji-id="${FIRE_ID}">🔥</tg-emoji> Премиум 🎁`;

describe('operator cards the panel sends as it built them', () => {
  it('/notify-dev: the card, HTML kept, the pack emoji as a <tg-emoji> tag', async () => {
    const h = start(packConfig(true));
    expect(await h.call('/notify-dev', { eventId: freshEventId('dev'), text: HTML_CARD, parseMode: 'HTML' })).toBe(204);

    const { text, options } = sentText(h.sendMessage);
    expect(text).toBe(HTML_RESOLVED);
    expect(options['parse_mode']).toBe('HTML');
  });

  it('/notify-dev without a parse mode: glyphs, and the pack emoji as an entity', async () => {
    const h = start(packConfig(true));
    expect(await h.call('/notify-dev', { eventId: freshEventId('dev-plain'), text: ':fire: Сбой {{GIFT}}' })).toBe(204);

    const { text, options } = sentText(h.sendMessage);
    expect(text).toBe('🔥 Сбой 🎁');
    expect(options['parse_mode']).toBeUndefined();
    expect(options['entities']).toEqual([{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE_ID }]);
  });

  // Telegram refuses a bot message carrying custom emoji when the bot's owner
  // has no Premium: the operator's card would never arrive.
  it('/notify-dev, owner without Premium: the card in glyphs, no <tg-emoji>', async () => {
    const h = start(packConfig(false));
    expect(await h.call('/notify-dev', { eventId: freshEventId('dev-np'), text: HTML_CARD, parseMode: 'HTML' })).toBe(204);

    const { text, options } = sentText(h.sendMessage);
    expect(text).toBe('<b>Новый платёж</b>\nТариф: 🔥 Премиум 🎁');
    expect(options['parse_mode']).toBe('HTML');
  });

  it('/notify-dev without a parse mode, owner without Premium: glyphs, no entity', async () => {
    const h = start(packConfig(false));
    expect(await h.call('/notify-dev', { eventId: freshEventId('dev-plain-np'), text: ':fire: Сбой {{GIFT}}' })).toBe(204);

    const { text, options } = sentText(h.sendMessage);
    expect(text).toBe('🔥 Сбой 🎁');
    expect(options['entities']).toBeUndefined();
  });

  it('/notify-dev from a config that does not say: read as Premium, the contract’s default', async () => {
    const h = start({ ...DEFAULT_BOT_CONFIG, customEmojis: packConfig(true).customEmojis });
    expect(await h.call('/notify-dev', { eventId: freshEventId('dev-unset'), text: HTML_CARD, parseMode: 'HTML' })).toBe(204);

    expect(sentText(h.sendMessage).text).toBe(HTML_RESOLVED);
  });

  it('/notify-dev-document: the caption, HTML kept', async () => {
    const h = start(packConfig(true));
    expect(
      await h.call('/notify-dev-document', {
        eventId: freshEventId('dev-doc'),
        content: 'stack trace',
        caption: HTML_CARD,
        parseMode: 'HTML',
      }),
    ).toBe(204);

    const options = (h.sendDocument.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options['caption']).toBe(HTML_RESOLVED);
    expect(options['parse_mode']).toBe('HTML');
  });

  it('/notify-broadcast-document: the caption, HTML kept', async () => {
    const h = start(packConfig(true));
    expect(
      await h.call('/notify-broadcast-document', {
        eventId: freshEventId('bcast-doc'),
        chatId: '-1001234567890',
        content: 'stack trace',
        caption: HTML_CARD,
        parseMode: 'HTML',
      }),
    ).toBe(204);

    const options = (h.sendDocument.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options['caption']).toBe(HTML_RESOLVED);
    expect(options['parse_mode']).toBe('HTML');
  });

  it('/notify-broadcast-document without a parse mode: the caption in glyphs, the emoji as a caption entity', async () => {
    const h = start(packConfig(true));
    expect(
      await h.call('/notify-broadcast-document', {
        eventId: freshEventId('bcast-doc-plain'),
        chatId: '-1001234567890',
        content: 'stack trace',
        caption: ':fire: Отчёт',
      }),
    ).toBe(204);

    const options = (h.sendDocument.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options['caption']).toBe('🔥 Отчёт');
    expect(options['caption_entities']).toEqual([{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE_ID }]);
    expect(options['parse_mode']).toBeUndefined();
  });
});

describe('a MarkdownV2 message keeps its parse mode, and so its formatting', () => {
  // Written as a correct MarkdownV2 text is: `_`, `{`, `}`, `.` and `!` are
  // reserved there, so the operator's slot and the underscore in a slug arrive
  // escaped. Both spellings of a token are tokens.
  const MARKDOWN = '*Акция\\!* :fire: скидка \\{\\{GIFT\\}\\} и :spark\\_one: :keycap: {{GIFT}}\\.';

  it('/notify-broadcast, owner with Premium: the pack emoji in MarkdownV2’s own custom-emoji syntax', async () => {
    const h = start(packConfig(true));
    expect(
      await h.call('/notify-broadcast', {
        eventId: freshEventId('md-premium'),
        chatId: '-1001234567890',
        text: MARKDOWN,
        parseMode: 'MarkdownV2',
      }),
    ).toBe(200);

    const { text, options } = sentText(h.sendMessage);
    expect(options['parse_mode']).toBe('MarkdownV2');
    expect(options['entities']).toBeUndefined();
    expect(text).toBe(
      `*Акция\\!* ![🔥](tg://emoji?id=${FIRE_ID}) скидка 🎁 и ![✨](tg://emoji?id=${SPARK_ID}) \\#️⃣ 🎁\\.`,
    );
  });

  it('/notify, owner without Premium: glyphs, escaped where MarkdownV2 reserves them', async () => {
    const h = start(packConfig(false));
    expect(
      await h.call('/notify', { eventId: freshEventId('md-plain'), telegramId: '42', text: MARKDOWN, parseMode: 'MarkdownV2' }),
    ).toBe(200);

    const { text, options } = sentText(h.sendMessage);
    expect(options['parse_mode']).toBe('MarkdownV2');
    expect(options['entities']).toBeUndefined();
    expect(text).toBe('*Акция\\!* 🔥 скидка 🎁 и ✨ \\#️⃣ 🎁\\.');
  });

  it('leaves code and pre alone: what is written there is literal', async () => {
    const h = start(packConfig(true));
    const text = 'Напишите `:fire:` или\n```\n{{GIFT}} :fire:\n```\nи :fire:';
    expect(
      await h.call('/notify', { eventId: freshEventId('md-code'), telegramId: '42', text, parseMode: 'MarkdownV2' }),
    ).toBe(200);

    expect(sentText(h.sendMessage).text).toBe(
      `Напишите \`:fire:\` или\n\`\`\`\n{{GIFT}} :fire:\n\`\`\`\nи ![🔥](tg://emoji?id=${FIRE_ID})`,
    );
  });
});

/**
 * A subscriber's own words inside a card: the panel writes them with `:` `{`
 * `}` as numeric references (its `literalCardText`), so the token pass here —
 * which resolves the operator's `:slug:` and `{{KEY}}` across the whole card —
 * finds nothing to resolve in them, and Telegram, which reads every numeric
 * reference, shows them as typed. A ticket subject «ключ {{SUB_ID}} не
 * работает, пишу :fire: срочно» used to reach the operator as «ключ • не
 * работает, пишу 🔥 срочно».
 *
 * This pins the half on this side: the listener passes those references
 * through untouched on every route a card or a notification takes, while the
 * operator's own tokens in the same text are still resolved. Were this pass to
 * start decoding entities first, the subscriber's words would be read as
 * tokens again.
 */
describe('a subscriber’s own words in what the panel sends, written as the panel writes them', () => {
  /** The panel's `literalCardText('ключ {{SUB_ID}} не работает, пишу :fire: срочно <b>&')`. */
  const CARRIED =
    'ключ &#123;&#123;SUB_ID&#125;&#125; не работает, пишу &#58;fire&#58; срочно &lt;b&gt;&amp;';
  const CARD = `<b>:fire: Новое обращение</b>\n📨 Тема: ${CARRIED}`;
  const SENT = `<b><tg-emoji emoji-id="${FIRE_ID}">🔥</tg-emoji> Новое обращение</b>\n📨 Тема: ${CARRIED}`;

  /** Telegram's reading of the text: tags gone, every numeric reference and the named ones decoded. */
  function asTelegramShows(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  it('/notify-dev and /notify-broadcast: passed through as written, the card’s own emoji resolved', async () => {
    const h = start(packConfig(true));
    expect(await h.call('/notify-dev', { eventId: freshEventId('lit-dev'), text: CARD, parseMode: 'HTML' })).toBe(204);
    expect(
      await h.call('/notify-broadcast', {
        eventId: freshEventId('lit-bcast'),
        chatId: '-1001234567890',
        text: CARD,
        parseMode: 'HTML',
      }),
    ).toBe(200);

    for (const index of [0, 1]) {
      const { text } = sentText(h.sendMessage, index);
      expect(text).toBe(SENT);
      expect(asTelegramShows(text)).toContain('Тема: ключ {{SUB_ID}} не работает, пишу :fire: срочно <b>&');
    }
  });

  it('/notify-dev-document and /notify-broadcast-document: the caption passed through as written', async () => {
    const h = start(packConfig(true));
    await h.call('/notify-dev-document', { eventId: freshEventId('lit-dev-doc'), content: 'x', caption: CARD, parseMode: 'HTML' });
    await h.call('/notify-broadcast-document', {
      eventId: freshEventId('lit-bcast-doc'),
      chatId: '-1001234567890',
      content: 'x',
      caption: CARD,
      parseMode: 'HTML',
    });

    for (const call of h.sendDocument.mock.calls as unknown[][]) {
      expect((call[2] as Record<string, unknown>)['caption']).toBe(SENT);
    }
    expect(h.sendDocument).toHaveBeenCalledTimes(2);
  });

  it('/notify: the subscriber’s own notification, the same', async () => {
    const h = start(packConfig(true));
    expect(await h.call('/notify', { eventId: freshEventId('lit-notify'), telegramId: '42', text: CARD, parseMode: 'HTML' })).toBe(
      200,
    );
    expect(sentText(h.sendMessage).text).toBe(SENT);
  });
});
