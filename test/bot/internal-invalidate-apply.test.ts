/**
 * `/invalidate` — what reaches Telegram after an operator's save.
 *
 * The listener re-reads the config (`BotConfigCache.forceInvalidate`) and hands
 * it to `onConfigApplied`, which pushes the copies Telegram holds: the slash
 * commands, the bot profile, the menu button. A read that FAILED still handed
 * back a config — the entry the bot already held, the saved copy, or, on a cold
 * start with no saved copy, DEFAULT — and that was pushed: the operator's
 * profile, commands and menu button overwritten with the defaults. A failed
 * read pushes nothing now; the next successful one is what counts.
 *
 * Driven through the real listener on a socket with real internal-HMAC
 * headers, over the real cache.
 */
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../src/infrastructure/bot-config/types.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const SECRET = 's'.repeat(32);

const BEFORE_SAVE: BotConfig = { ...DEFAULT_BOT_CONFIG, visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: 'before' } };
const SAVED: BotConfig = { ...DEFAULT_BOT_CONFIG, visual: { ...DEFAULT_BOT_CONFIG.visual, supportUsername: 'saved' } };

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!();
});

function silentLogger(): ListenerOptions['logger'] {
  return pino({ level: 'silent' }, new Writable({ write: (_chunk, _encoding, callback) => callback() }));
}

/** The listener over `cache`, and a signed POST to it. */
async function listen(cache: BotConfigCache, onConfigApplied: (config: BotConfig) => Promise<void>) {
  const server = startInternalHttpListener({
    bot: null,
    cache,
    secret: SECRET,
    port: 0,
    logger: silentLogger(),
    onConfigApplied,
  });
  if (server === null) throw new Error('listener did not start');
  await once(server, 'listening');
  running.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return async (path: string, body: Record<string, unknown>): Promise<number> => {
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
}

function cacheOn(fetcher: () => Promise<unknown>): BotConfigCache {
  return new BotConfigCache({ fetcher, hydrator: { setOverrides: () => undefined }, fallback: DEFAULT_BOT_CONFIG });
}

describe('/invalidate — what is pushed to Telegram', () => {
  it('an invalidate whose read fails applies nothing — not the config the bot held', async () => {
    let panelDown = false;
    const cache = cacheOn(async () => {
      if (panelDown) throw new Error('connect ECONNREFUSED');
      return BEFORE_SAVE;
    });
    await cache.get(); // the boot read
    const onConfigApplied = vi.fn(async () => undefined);
    const call = await listen(cache, onConfigApplied);

    panelDown = true;
    expect(await call('/invalidate', { reason: 'operator save' })).toBe(204);
    expect(onConfigApplied).not.toHaveBeenCalled();
    // The bot keeps reading the config it held until a read succeeds.
    expect(cache.peek()).toBe(BEFORE_SAVE);
  });

  it('an invalidate whose read fails on a cold start applies nothing — not DEFAULT', async () => {
    const cache = cacheOn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const onConfigApplied = vi.fn(async () => undefined);
    const call = await listen(cache, onConfigApplied);

    expect(await call('/invalidate', { reason: 'operator save' })).toBe(204);
    expect(onConfigApplied).not.toHaveBeenCalled();
  });

  it('an invalidate whose read succeeds applies the new config', async () => {
    let saved = false;
    const cache = cacheOn(async () => (saved ? SAVED : BEFORE_SAVE));
    await cache.get();
    const onConfigApplied = vi.fn(async () => undefined);
    const call = await listen(cache, onConfigApplied);

    saved = true;
    expect(await call('/invalidate', { reason: 'operator save' })).toBe(204);
    await vi.waitFor(() => expect(onConfigApplied).toHaveBeenCalledTimes(1));
    expect(onConfigApplied).toHaveBeenCalledWith(SAVED);
  });
});
