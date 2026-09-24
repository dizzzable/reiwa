/**
 * What Telegram holds of the operator's settings — the bot's name and
 * descriptions, the `/` command list, the menu button — follows the config the
 * panel answers with.
 *
 * These were pushed at boot and after a save (`/invalidate`). A save whose read
 * failed — the panel slow or down at that moment — pushed nothing, rightly (a
 * failed read hands back nothing to push), and nothing pushed it later: the old
 * name and commands stayed until the next save or a restart. Now every answered
 * read offers its config (`BotConfigCache` `onAnswered`), and what differs from
 * what last went out, goes out:
 *
 *   • a failed save, then the next warm-up: the save reaches Telegram;
 *   • an answered read whose fingerprint is unchanged: no Bot API call at all;
 *   • a failed read — the held entry, the saved copy, DEFAULT: nothing;
 *   • Telegram's limits: a 429's `retry_after` is waited out, one push at a
 *     time, the newest waiting config wins.
 *
 * Over the real cache, the real translator it hydrates, the real listener for
 * the save and the real warm-up; Telegram is a fake that keeps what it was told.
 */
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { GrammyError } from 'grammy';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConfigWarmup } from '../../../src/bot/lib/config-warmup.js';
import {
  createTelegramSettingsSync,
  telegramSettingsOf,
  type TelegramSettingsSync,
} from '../../../src/bot/lib/telegram-settings-sync.js';
import { startInternalHttpListener } from '../../../src/bot/listeners/internal-http-listener.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import { Translator } from '../../../src/infrastructure/i18n/translator/translator.js';
import type { ConfigPersistencePort } from '../../../src/application/ports/config-persistence.port.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../../src/lib/internal-hmac.js';

const MINI_APP = 'https://app.example.test';
const SECRET = 's'.repeat(32);

/** A config as the panel sends it: a profile, a menu button, and a `/start` description of its own. */
function panelConfig(version: string): BotConfig & { translations: Record<string, string> } {
  return {
    ...DEFAULT_BOT_CONFIG,
    profile: { name: `Bot ${version}`, description: `About ${version}` },
    menuButton: { kind: 'web_app', text: `Open ${version}` },
    translations: {
      'ru.commands.start.description': `Старт ${version}`,
      'en.commands.start.description': `Start ${version}`,
    },
  };
}

type Call = { readonly method: string; readonly args: readonly unknown[] };

/** A Telegram that keeps what it is told, and every call made to it. */
function fakeTelegram() {
  const calls: Call[] = [];
  const profile = new Map<string, string>();
  const commands = new Map<string, ReadonlyArray<{ command: string; description: string }>>();
  let menuButton: Record<string, unknown> = { type: 'default' };
  /** Throws this for the next calls to `method`, as many times as it says. */
  const failNext = new Map<string, { readonly err: unknown; times: number }>();
  let inFlight = 0;
  let maxInFlight = 0;
  let gate: Promise<void> | null = null;

  const call = <T>(method: string, args: unknown[], answer: () => T): Promise<T> => {
    calls.push({ method, args });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const run = async (): Promise<T> => {
      try {
        if (gate !== null) await gate;
        const failure = failNext.get(method);
        if (failure !== undefined) {
          failure.times -= 1;
          if (failure.times <= 0) failNext.delete(method);
          throw failure.err;
        }
        return answer();
      } finally {
        inFlight -= 1;
      }
    };
    return run();
  };
  const slot = (field: string, other?: { language_code?: string }) => `${field}:${other?.language_code ?? ''}`;

  const api = {
    getMyName: (other?: { language_code?: string }) =>
      call('getMyName', [other], () => ({ name: profile.get(slot('name', other)) ?? '' })),
    setMyName: (name: string, other?: { language_code?: string }) =>
      call('setMyName', [name, other], () => profile.set(slot('name', other), name) && true),
    getMyDescription: (other?: { language_code?: string }) =>
      call('getMyDescription', [other], () => ({ description: profile.get(slot('description', other)) ?? '' })),
    setMyDescription: (description: string, other?: { language_code?: string }) =>
      call('setMyDescription', [description, other], () => profile.set(slot('description', other), description) && true),
    getMyShortDescription: (other?: { language_code?: string }) =>
      call('getMyShortDescription', [other], () => ({ short_description: profile.get(slot('short', other)) ?? '' })),
    setMyShortDescription: (value: string, other?: { language_code?: string }) =>
      call('setMyShortDescription', [value, other], () => profile.set(slot('short', other), value) && true),
    getChatMenuButton: () => call('getChatMenuButton', [], () => menuButton),
    setChatMenuButton: (other: { menu_button: Record<string, unknown> }) =>
      call('setChatMenuButton', [other], () => {
        menuButton = other.menu_button;
        return true;
      }),
    setMyCommands: (list: ReadonlyArray<{ command: string; description: string }>, other?: { language_code?: string }) =>
      call('setMyCommands', [list, other], () => {
        commands.set(other?.language_code ?? 'default', list);
        return true;
      }),
  };

  return {
    api,
    calls,
    name: () => profile.get('name:') ?? null,
    shortDescription: () => profile.get('short:') ?? null,
    menuButton: () => menuButton,
    startDescription: (scope: string) => commands.get(scope)?.find((c) => c.command === 'start')?.description ?? null,
    failNext: (method: string, err: unknown, times = 1) => failNext.set(method, { err, times }),
    /** Holds every call until the returned release is called. */
    hold: (): (() => void) => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    maxInFlight: () => maxInFlight,
  };
}

/** A 429 as grammY throws it. */
function tooManyRequests(retryAfterSeconds: number, method = 'setMyName'): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    {
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfterSeconds}`,
      parameters: { retry_after: retryAfterSeconds },
    },
    method,
    {},
  );
}

/** The panel as the bot reads it: a config, or down. */
function panel(initial: BotConfig | null) {
  const state = { config: initial as BotConfig | null, reads: 0 };
  return {
    state,
    fetcher: async (): Promise<unknown> => {
      state.reads += 1;
      if (state.config === null) throw new Error('connect ECONNREFUSED 10.0.0.2:8000');
      return state.config;
    },
  };
}

/** The bot's wiring, as `bot/main.ts` has it: the cache announces answered reads to the sync. */
function bot(options: { readonly config: BotConfig | null; readonly persisted?: BotConfig; readonly now?: () => number }) {
  const telegram = fakeTelegram();
  const translator = new Translator();
  const upstream = panel(options.config);
  const sync: TelegramSettingsSync = createTelegramSettingsSync({ now: options.now });
  const persistence: ConfigPersistencePort | undefined =
    options.persisted === undefined
      ? undefined
      : { load: async () => options.persisted ?? null, save: async () => undefined };
  const cache = new BotConfigCache({
    fetcher: upstream.fetcher,
    hydrator: translator,
    fallback: DEFAULT_BOT_CONFIG,
    persistence,
    onAnswered: (fresh) => void sync.offer(fresh),
  });
  const start = () =>
    sync.start(telegramSettingsOf({ bot: { api: telegram.api } as never, translator, miniAppUrl: MINI_APP }));
  return { telegram, translator, upstream, sync, cache, start };
}

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!();
  vi.useRealTimers();
});

/** The internal listener, its save pushed on as `bot/main.ts` wires it, and a signed `/invalidate`. */
async function listener(cache: BotConfigCache, sync: TelegramSettingsSync): Promise<() => Promise<number>> {
  const server = startInternalHttpListener({
    bot: null,
    cache,
    secret: SECRET,
    port: 0,
    logger: pino({ level: 'silent' }, new Writable({ write: (_c, _e, done) => done() })),
    onConfigApplied: (fresh) => sync.offer(fresh, { force: true }),
  });
  if (server === null) throw new Error('listener did not start');
  await once(server, 'listening');
  running.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return async () => {
    const raw = JSON.stringify({ reason: 'operator save' });
    const { timestamp, signature } = buildInternalSignature({ secret: SECRET, method: 'POST', path: '/invalidate', body: raw });
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/invalidate',
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

/** Waits (real time) until `done`, or fails after two seconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the Telegram-side settings after a save whose read failed', () => {
  it('reach Telegram at the next warm-up — name, commands and menu button', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get(); // the boot read
    await start();
    expect(telegram.name()).toBe('Bot one');
    expect(telegram.startDescription('ru')).toBe('Старт one');

    // The operator saves «two»; the save's own read fails — the panel is down
    // at that moment. Nothing may be pushed from a failed read.
    const invalidate = await listener(cache, sync);
    upstream.state.config = null;
    expect(await invalidate()).toBe(204);
    await sync.idle();
    expect(telegram.name()).toBe('Bot one');

    // The panel is back with the save; the warm-up reads it and it goes out.
    upstream.state.config = panelConfig('two');
    const warmup = startConfigWarmup(cache, 20);
    running.push(async () => clearInterval(warmup));
    await until(() => telegram.name() === 'Bot two', 'the saved name');
    await sync.idle();

    expect(telegram.startDescription('ru')).toBe('Старт two');
    expect(telegram.startDescription('en')).toBe('Start two');
    expect(telegram.startDescription('default')).toBe('Старт two');
    expect(telegram.menuButton()).toEqual({ type: 'web_app', text: 'Open two', web_app: { url: MINI_APP } });
  });

  it('reach Telegram at any later answered read, not only the warm-up’s', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    const invalidate = await listener(cache, sync);
    upstream.state.config = null;
    await invalidate();
    await sync.idle();

    upstream.state.config = panelConfig('two');
    // The failed read's hold-off (10 s) over, a user's action reads the panel.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11_000);
    await cache.get();
    vi.useRealTimers();
    await sync.idle();
    expect(telegram.name()).toBe('Bot two');
  });

  it('go out at the save itself when its read succeeds — once, not a second time from the read', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    const invalidate = await listener(cache, sync);
    const before = telegram.calls.length;

    upstream.state.config = panelConfig('two');
    expect(await invalidate()).toBe(204);
    await until(() => telegram.name() === 'Bot two', 'the saved name');
    await sync.idle();

    const pushed = telegram.calls.slice(before).map((c) => c.method);
    expect(pushed.filter((m) => m === 'setMyName')).toHaveLength(1);
    expect(pushed.filter((m) => m === 'setMyCommands')).toHaveLength(3);
    expect(pushed.filter((m) => m === 'getMyName')).toHaveLength(1);
  });
});

describe('an answered read whose fingerprint is unchanged', () => {
  it('calls Telegram for nothing — not a getter, not a setter', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    const before = telegram.calls.length;
    expect(before).toBeGreaterThan(0);

    for (let tick = 0; tick < 3; tick += 1) {
      await cache.refresh(); // the warm-up's read
      await sync.idle();
    }
    expect(upstream.state.reads).toBe(4);
    expect(telegram.calls.slice(before)).toEqual([]);
  });

  it('pushes only the part that changed', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    const before = telegram.calls.length;

    // Only the `/start` description changed.
    upstream.state.config = {
      ...panelConfig('one'),
      translations: { 'ru.commands.start.description': 'Старт три', 'en.commands.start.description': 'Start three' },
    } as BotConfig;
    await cache.refresh();
    await sync.idle();

    expect([...new Set(telegram.calls.slice(before).map((c) => c.method))]).toEqual(['setMyCommands']);
    expect(telegram.startDescription('en')).toBe('Start three');
  });
});

describe('a failed read', () => {
  it('pushes nothing at the warm-up — not the config the bot holds', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    const before = telegram.calls.length;

    upstream.state.config = null;
    await cache.refresh();
    await sync.idle();
    expect(upstream.state.reads).toBe(2);
    expect(telegram.calls.slice(before)).toEqual([]);
  });

  it('pushes nothing on a cold start with the panel down — not DEFAULT, not the saved copy', async () => {
    for (const persisted of [undefined, panelConfig('saved')]) {
      const { telegram, cache, start, sync } = bot({ config: null, persisted });
      await cache.get(); // the boot read, failed: DEFAULT or the saved copy served
      await start();
      await cache.refresh();
      await sync.idle();
      expect(telegram.calls, persisted === undefined ? 'DEFAULT' : 'the saved copy').toEqual([]);
    }
  });

  it('is made up for by the first read that is answered', async () => {
    const { telegram, upstream, sync, cache, start } = bot({ config: null, persisted: panelConfig('saved') });
    await cache.get();
    await start();
    upstream.state.config = panelConfig('one');
    await cache.refresh();
    await sync.idle();
    expect(telegram.name()).toBe('Bot one');
  });
});

describe('Telegram’s limits', () => {
  it('waits out a 429’s retry_after for that part, and pushes it at the first answered read after', async () => {
    let clock = 1_000_000;
    const { telegram, upstream, sync, cache, start } = bot({ config: panelConfig('one'), now: () => clock });
    telegram.failNext('setMyName', tooManyRequests(60));
    await cache.get();
    await start();
    expect(telegram.name()).toBeNull();
    // The commands and the menu button were not held back by the profile's 429.
    expect(telegram.startDescription('ru')).toBe('Старт one');

    const count = (method: string) => telegram.calls.filter((c) => c.method === method).length;
    const names = count('getMyName');
    clock += 59_000;
    await cache.refresh();
    await sync.idle();
    expect(count('getMyName'), 'asked again before retry_after was over').toBe(names);

    clock += 2_000;
    await cache.refresh();
    await sync.idle();
    expect(telegram.name()).toBe('Bot one');
    expect(upstream.state.reads).toBe(3);
  });

  it('holds only the field Telegram put off: a short description saved meanwhile goes out at once', async () => {
    let clock = 1_000_000;
    const { telegram, sync, cache, start } = bot({ config: panelConfig('one'), now: () => clock });
    await cache.get();
    await start();
    const saved = (shortDescription: string): BotConfig => ({
      ...panelConfig('one'),
      profile: { name: 'Bot renamed', description: 'About one', shortDescription },
    });

    // Save 1 renames the bot and sets a short description; the rename gets a 429.
    telegram.failNext('setMyName', tooManyRequests(60));
    await sync.offer(saved('S1'), { force: true });
    expect(telegram.name()).toBe('Bot one');
    expect(telegram.shortDescription()).toBe('S1');

    // Save 2, within the minute, changes only the short description: it goes
    // at once, as it did when every field was pushed on its own.
    clock += 10_000;
    const before = telegram.calls.length;
    await sync.offer(saved('S2'), { force: true });
    expect(telegram.shortDescription()).toBe('S2');
    // The name alone waits out its retry_after — not even read before it is over.
    expect(telegram.calls.slice(before).map((c) => c.method)).not.toContain('getMyName');
    expect(telegram.name()).toBe('Bot one');

    clock += 60_000;
    await sync.offer(saved('S2'));
    expect(telegram.name()).toBe('Bot renamed');
  });

  it('tries a part that failed otherwise at the next answered read, and nothing else again', async () => {
    const { telegram, sync, cache, start } = bot({ config: panelConfig('one') });
    telegram.failNext('setChatMenuButton', new Error('socket hang up'));
    await cache.get();
    await start();
    expect(telegram.menuButton()).toEqual({ type: 'default' });
    const before = telegram.calls.length;

    await cache.refresh();
    await sync.idle();
    expect(telegram.calls.slice(before).map((c) => c.method)).toEqual(['getChatMenuButton', 'setChatMenuButton']);
    expect(telegram.menuButton()).toMatchObject({ type: 'web_app', text: 'Open one' });
  });

  it('sends the command list again at the next answered read when a scope of it failed', async () => {
    const { telegram, sync, cache, start } = bot({ config: panelConfig('one') });
    // The default scope, and the one retry it gets inside the push.
    telegram.failNext('setMyCommands', new Error('socket hang up'), 2);
    await cache.get();
    await start();
    const before = telegram.calls.filter((c) => c.method === 'setMyCommands').length;

    await cache.refresh();
    await sync.idle();
    expect(telegram.calls.filter((c) => c.method === 'setMyCommands').length - before).toBe(3);
    expect(telegram.startDescription('default')).toBe('Старт one');
  });

  it('pushes one config at a time, and of those that waited only the newest', async () => {
    const { telegram, sync, start } = bot({ config: null });
    await start();
    const release = telegram.hold();
    const first = sync.offer(panelConfig('one'));
    await until(() => telegram.calls.length > 0, 'the first push');
    void sync.offer(panelConfig('two'));
    void sync.offer(panelConfig('three'));
    release();
    await first;
    await sync.idle();

    expect(telegram.maxInFlight()).toBe(1);
    const names = telegram.calls.filter((c) => c.method === 'setMyName').map((c) => c.args[0]);
    expect(names).toEqual(['Bot one', 'Bot three']);
    expect(telegram.name()).toBe('Bot three');
  });
});

describe('a save, forced', () => {
  it('re-reads the profile and the menu button from Telegram, and sends the commands only when they changed', async () => {
    const { telegram, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    const before = telegram.calls.length;

    await sync.offer(panelConfig('one'), { force: true });
    const methods = telegram.calls.slice(before).map((c) => c.method);
    expect(methods).toContain('getMyName');
    expect(methods).toContain('getChatMenuButton');
    expect(methods).not.toContain('setMyCommands');
    expect(methods.filter((m) => m.startsWith('set'))).toEqual([]);
  });

  it('stays forced when an answered read of the same config lands while the save waits behind a push', async () => {
    const { telegram, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    await telegram.api.setMyName('Renamed by hand');
    const before = telegram.calls.length;

    // A push is under way (a read whose menu button changed)…
    const release = telegram.hold();
    const pushing = sync.offer({ ...panelConfig('one'), menuButton: { kind: 'web_app', text: 'Open later' } });
    await until(() => telegram.calls.length > before, 'a push under way');
    // …the operator saves meanwhile, and a warm-up read of the same config
    // lands before the save's turn comes. They wait as one — still a save.
    void sync.offer(panelConfig('one'), { force: true });
    void sync.offer(panelConfig('one'));
    release();
    await pushing;
    await sync.idle();

    // The save re-read the name from Telegram and put the panel's back.
    expect(telegram.name()).toBe('Bot one');
  });

  it('puts back a name changed by hand in @BotFather — as a save always did', async () => {
    const { telegram, sync, cache, start } = bot({ config: panelConfig('one') });
    await cache.get();
    await start();
    await telegram.api.setMyName('Renamed by hand');

    await cache.refresh();
    await sync.idle();
    expect(telegram.name(), 'an unchanged fingerprint is no reason to call Telegram').toBe('Renamed by hand');
    await sync.offer(panelConfig('one'), { force: true });
    expect(telegram.name()).toBe('Bot one');
  });
});

describe('BotConfigCache — what it announces', () => {
  function cacheWith(fetcher: () => Promise<unknown>, persistence?: ConfigPersistencePort) {
    const heard: BotConfig[] = [];
    const cache = new BotConfigCache({
      fetcher,
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      persistence,
      onAnswered: (config) => heard.push(config),
    });
    return { cache, heard };
  }

  it('every read the panel answered, get() and refresh() alike', async () => {
    const one = panelConfig('one');
    const { cache, heard } = cacheWith(async () => one);
    await cache.get();
    await cache.refresh();
    expect(heard).toEqual([one, one]);
  });

  it('after the translator took the read’s texts', async () => {
    const translator = new Translator();
    let seen: string | null = null;
    const cache = new BotConfigCache({
      fetcher: async () => panelConfig('one'),
      hydrator: translator,
      fallback: DEFAULT_BOT_CONFIG,
      onAnswered: () => {
        seen = translator.t('commands.start.description', 'en');
      },
    });
    await cache.get();
    expect(seen).toBe('Start one');
  });

  it('not a failed read — not the held entry, the saved copy or DEFAULT', async () => {
    let up = true;
    const { cache, heard } = cacheWith(
      async () => {
        if (!up) throw new Error('down');
        return panelConfig('one');
      },
      { load: async () => panelConfig('saved'), save: async () => undefined },
    );
    up = false;
    await cache.get(); // cold: the saved copy
    up = true;
    await cache.refresh();
    up = false;
    await cache.refresh(); // warm: the held entry
    expect(heard.map((config) => config.profile?.name)).toEqual(['Bot one']);
  });

  it('not the read of forceInvalidate itself: its caller pushes that one', async () => {
    const { cache, heard } = cacheWith(async () => panelConfig('two'));
    const fresh = await cache.forceInvalidate('admin-pushed');
    expect(fresh?.profile?.name).toBe('Bot two');
    expect(heard).toEqual([]);
  });

  it('not a read an invalidate overtook', async () => {
    let answer!: (config: BotConfig) => void;
    let calls = 0;
    const { cache, heard } = cacheWith(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls === 1) answer = resolve;
          else resolve(panelConfig('two'));
        }),
    );
    const stale = cache.get();
    await cache.forceInvalidate('admin-pushed');
    answer(panelConfig('one'));
    await stale;
    expect(heard).toEqual([]);
  });

  it('keeps reading when the listener throws', async () => {
    const cache = new BotConfigCache({
      fetcher: async () => panelConfig('one'),
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      onAnswered: () => {
        throw new Error('listener bug');
      },
    });
    await expect(cache.get()).resolves.toMatchObject({ profile: { name: 'Bot one' } });
    expect(cache.peek()?.profile?.name).toBe('Bot one');
  });
});
