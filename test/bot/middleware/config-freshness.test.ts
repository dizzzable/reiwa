/**
 * The freshness middleware — every press answered from the newest settings
 * reiwa knows of (owner's decision, 24.09.2026; `middleware/config-freshness.ts`).
 *
 * Pinned here:
 *  - which updates it looks at, and how long each may wait: a button or an
 *    inline query a quarter second, a message a second — measured, with Redis
 *    and the panel both hanging — and nothing else waits at all;
 *  - it never throws into the update;
 *  - the legal documents only for a press that opens the rules screen;
 *  - with a real `BotConfigCache` behind it: a steady state costs no panel read
 *    per press and one Redis read per burst, and a hint heard costs one read,
 *    waited for, then nothing.
 */
import { Api, Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createConfigFreshnessMiddleware,
  freshnessBudgetOf,
  opensRulesScreen,
  type BotConfigCatchUp,
  type ConfigFreshnessDeps,
  type LegalDocumentsCatchUp,
  type PolicyCatchUp,
} from '../../../src/bot/middleware/config-freshness.js';
import { PolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import type { PlatformPolicyShape } from '../../../src/infrastructure/admin-client/namespaces/system.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig, BotScreen } from '../../../src/infrastructure/bot-config/types.js';
import {
  RedisLatestConfigVersions,
  memoiseLatest,
  type KnownPanelChange,
  type LatestConfigVersions,
} from '../../../src/infrastructure/config-versions/latest.js';

const BOT_INFO: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: 'Reiwa',
  username: 'reiwa_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: true,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const USER = { id: 4242, is_bot: false, first_name: 'Ann', language_code: 'ru' } as const;
const PRIVATE = { id: USER.id, type: 'private', first_name: USER.first_name } as const;
const API = new Api('123456789:AAHfakeTokenForFreshnessSpecs000000');

function contextOf(update: Omit<Update, 'update_id'>): BotContext {
  return new Context({ update_id: 1, ...update } as Update, API, BOT_INFO) as BotContext;
}

function press(data: string): BotContext {
  return contextOf({
    callback_query: {
      id: 'cq-1',
      from: USER,
      chat_instance: 'ci-1',
      data,
      message: { message_id: 50, date: 0, chat: PRIVATE, from: BOT_INFO, text: 'an old menu' },
    },
  } as never);
}

function message(text: string, chat: Record<string, unknown> = PRIVATE): BotContext {
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : undefined;
  return contextOf({
    message: { message_id: 7, date: 0, chat, from: USER, text, ...(entities !== undefined ? { entities } : {}) },
  } as never);
}

function screen(shortId: string, name: string): BotScreen {
  return {
    id: `s-${shortId}`,
    shortId,
    name,
    textRu: name,
    textEn: '',
    parseMode: 'plain',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    isRoot: false,
    buttons: [],
  };
}

const V1 = '1'.repeat(32);

function deps(over: Partial<ConfigFreshnessDeps> = {}): ConfigFreshnessDeps {
  return {
    latest: async () => null,
    botConfig: () => null,
    legalDocuments: () => null,
    userLocale: { getSync: () => 'ru' },
    peekConfig: () => null,
    ...over,
  };
}

/** How long the middleware held the update before `next()`, in fake ms, up to `limit`. */
async function heldFor(ctx: BotContext, d: ConfigFreshnessDeps, limit = 3_000): Promise<number | null> {
  const next = vi.fn(async () => undefined);
  void createConfigFreshnessMiddleware(d)(ctx, next);
  for (let elapsed = 0; elapsed <= limit; elapsed += 1) {
    await vi.advanceTimersByTimeAsync(elapsed === 0 ? 0 : 1);
    if (next.mock.calls.length > 0) return elapsed;
  }
  return null;
}

const hangs = <T>(): Promise<T> => new Promise<T>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe('which updates wait, and how long', () => {
  it('a button, an inline query: a quarter second; a message in the user’s chat: a second', () => {
    // Literals on purpose: a fixture read from the constants would move with them.
    expect(freshnessBudgetOf(press('help'))).toBe(250);
    expect(
      freshnessBudgetOf(contextOf({ inline_query: { id: 'iq', from: USER, query: '', offset: '' } } as never)),
    ).toBe(250);
    expect(freshnessBudgetOf(message('/start'))).toBe(1_000);
    expect(freshnessBudgetOf(message('hello'))).toBe(1_000);
  });

  it('nothing the pages render words for: service messages, payments, group chatter, members', () => {
    const paid = contextOf({
      message: {
        message_id: 8,
        date: 0,
        chat: PRIVATE,
        from: USER,
        successful_payment: {
          currency: 'XTR',
          total_amount: 1,
          invoice_payload: 'p',
          telegram_payment_charge_id: 't',
          provider_payment_charge_id: 'p',
        },
      },
    } as never);
    const checkout = contextOf({
      pre_checkout_query: { id: 'pc', from: USER, currency: 'XTR', total_amount: 1, invoice_payload: 'p' },
    } as never);
    const member = contextOf({
      my_chat_member: {
        chat: PRIVATE,
        from: USER,
        date: 0,
        old_chat_member: { status: 'member', user: BOT_INFO },
        new_chat_member: { status: 'kicked', user: BOT_INFO, until_date: 0 },
      },
    } as never);
    expect(freshnessBudgetOf(paid)).toBeNull();
    expect(freshnessBudgetOf(checkout)).toBeNull();
    expect(freshnessBudgetOf(member)).toBeNull();
    expect(freshnessBudgetOf(message('hello', { id: -100, type: 'supergroup', title: 'Chat' }))).toBeNull();
  });

  it('never holds a button past a quarter second, with Redis and the panel both hanging', async () => {
    vi.useFakeTimers();
    const botConfig: BotConfigCatchUp = { catchUp: vi.fn(() => hangs<void>()) };
    expect(await heldFor(press('help'), deps({ latest: hangs, botConfig: () => botConfig }))).toBe(250);
  });

  it('never holds a message past a second, with the panel hanging', async () => {
    vi.useFakeTimers();
    const botConfig: BotConfigCatchUp = { catchUp: vi.fn(() => hangs<void>()) };
    expect(await heldFor(message('/start'), deps({ botConfig: () => botConfig }))).toBe(1_000);
  });

  it('lets everything else through at once, asking nobody', async () => {
    vi.useFakeTimers();
    const latest = vi.fn(async () => null);
    const botConfig: BotConfigCatchUp = { catchUp: vi.fn(() => hangs<void>()) };
    const checkout = contextOf({
      pre_checkout_query: { id: 'pc', from: USER, currency: 'XTR', total_amount: 1, invoice_payload: 'p' },
    } as never);
    expect(await heldFor(checkout, deps({ latest, botConfig: () => botConfig }))).toBe(0);
    expect(latest).not.toHaveBeenCalled();
    expect(botConfig.catchUp).not.toHaveBeenCalled();
  });

  it('without a panel there is no cache to bring up to date, and Redis is not asked', async () => {
    vi.useFakeTimers();
    const latest = vi.fn(async () => null);
    expect(await heldFor(press('rules'), deps({ latest }))).toBe(0);
    expect(latest).not.toHaveBeenCalled();
  });

  it('never throws into the update: a failing Redis, a failing cache — the update goes on', async () => {
    vi.useFakeTimers();
    const botConfig: BotConfigCatchUp = {
      catchUp: vi.fn(async () => {
        throw new Error('cache blew up');
      }),
    };
    const latest = vi.fn(async (): Promise<LatestConfigVersions | null> => {
      throw new Error('redis blew up');
    });
    expect(await heldFor(press('help'), deps({ latest, botConfig: () => botConfig }))).toBe(0);
    expect(await heldFor(press('help'), deps({ botConfig: () => botConfig }))).toBe(0);
  });
});

describe('what it asks the caches', () => {
  const LATEST: LatestConfigVersions = {
    polled: { botConfig: { version: V1, at: 10 }, 'legalDocuments.en': { version: V1, at: 11 } },
    hinted: { botConfig: 20, 'legalDocuments.ru': 30 },
  };

  it('the bot config: what Redis knows of it, and the time left of the budget', async () => {
    const seen: Array<[KnownPanelChange, number]> = [];
    const botConfig: BotConfigCatchUp = {
      catchUp: async (known, budgetMs) => {
        seen.push([known, budgetMs]);
      },
    };
    const next = vi.fn(async () => undefined);
    await createConfigFreshnessMiddleware(deps({ latest: async () => LATEST, botConfig: () => botConfig }))(
      press('help'),
      next,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toEqual({ polled: { version: V1, at: 10 }, hintedAt: 20 });
    expect(seen[0]![1]).toBeGreaterThan(200);
    expect(seen[0]![1]).toBeLessThanOrEqual(250);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('the platform policy the gate decides on: what Redis knows of it, on every press', async () => {
    const LATEST_WITH_POLICY: LatestConfigVersions = {
      polled: { ...LATEST.polled, platformPolicy: { version: V1, at: 40 } },
      hinted: { ...LATEST.hinted, platformPolicy: 50 },
    };
    const policy: PolicyCatchUp = { catchUp: vi.fn(async () => undefined) };
    const middleware = createConfigFreshnessMiddleware(
      deps({ latest: async () => LATEST_WITH_POLICY, policy: () => policy }),
    );
    await middleware(press('help'), vi.fn(async () => undefined));
    await middleware(message('/start'), vi.fn(async () => undefined));
    expect(policy.catchUp).toHaveBeenCalledTimes(2);
    expect(policy.catchUp).toHaveBeenNthCalledWith(1, { polled: { version: V1, at: 40 }, hintedAt: 50 }, expect.any(Number));
  });

  it('with nothing known in Redis, still the cache — which knows its own `/invalidate`', async () => {
    const botConfig: BotConfigCatchUp = { catchUp: vi.fn(async () => undefined) };
    await createConfigFreshnessMiddleware(deps({ botConfig: () => botConfig }))(press('help'), vi.fn(async () => undefined));
    expect(botConfig.catchUp).toHaveBeenCalledWith({}, expect.any(Number));
  });

  it.each([
    ['the rules button', press('rules'), null, true],
    ['`/rules`', message('/rules'), null, true],
    ['`/rules@bot`', message('/rules@reiwa_test_bot'), null, true],
    ['a screen button onto the operator’s rules screen', press('screen:r1'), [screen('r1', 'Rules')], true],
    ['a bare shortId of the rules screen', press('r1'), [screen('r1', 'rules')], true],
    ['the help button', press('help'), null, false],
    ['a screen button onto another screen', press('screen:p1'), [screen('p1', 'promo')], false],
    ['`/start`', message('/start'), null, false],
    ['a word that is not a command', message('rules'), null, false],
  ] as const)('the legal documents for %s: %s', async (_what, ctx, screens, opens) => {
    const config: BotConfig | null = screens === null ? null : { ...DEFAULT_BOT_CONFIG, screens: [...screens] };
    expect(opensRulesScreen(ctx, config)).toBe(opens);

    const legal: LegalDocumentsCatchUp = { catchUp: vi.fn(async () => undefined) };
    await createConfigFreshnessMiddleware(
      deps({ latest: async () => LATEST, legalDocuments: () => legal, peekConfig: () => config }),
    )(ctx, vi.fn(async () => undefined));
    if (opens) {
      expect(legal.catchUp).toHaveBeenCalledExactlyOnceWith('ru', { hintedAt: 30 }, expect.any(Number));
    } else {
      expect(legal.catchUp).not.toHaveBeenCalled();
    }
  });

  it('the documents in the user’s language', async () => {
    const legal: LegalDocumentsCatchUp = { catchUp: vi.fn(async () => undefined) };
    await createConfigFreshnessMiddleware(
      deps({ latest: async () => LATEST, legalDocuments: () => legal, userLocale: { getSync: () => 'en' } }),
    )(press('rules'), vi.fn(async () => undefined));
    expect(legal.catchUp).toHaveBeenCalledExactlyOnceWith('en', { polled: { version: V1, at: 11 } }, expect.any(Number));
  });
});

/** A Redis hash in memory, counting reads. */
function fakeRedis() {
  const hash = new Map<string, string>();
  return {
    hash,
    redis: {
      hset: vi.fn(async (_key: string, fields: Record<string, string>) => {
        for (const [field, value] of Object.entries(fields)) hash.set(field, value);
        return 1;
      }),
      hgetall: vi.fn(async () => Object.fromEntries(hash)),
    },
  };
}

describe('with the bot’s real cache and the key in Redis', () => {
  const T0 = 1_800_000_000_000;
  const PUBLIC_POLICY: PlatformPolicyShape = {
    accessMode: 'PUBLIC',
    rulesRequired: false,
    rulesLink: null,
    channelRequired: false,
    channelLink: null,
    defaultCurrency: 'RUB',
  };
  const SAVE: BotConfig = { ...DEFAULT_BOT_CONFIG, visual: { ...DEFAULT_BOT_CONFIG.visual, welcomeMessage: 'after the save' } };

  async function running() {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const answers: Array<(config: BotConfig) => void> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<BotConfig>((resolve) => {
          answers.push(resolve);
        }),
    );
    const cache = new BotConfigCache({ fetcher, hydrator: { setOverrides: () => undefined }, fallback: DEFAULT_BOT_CONFIG });
    const boot = cache.get();
    answers[0]!(DEFAULT_BOT_CONFIG);
    await boot;
    // The platform policy, as the channel gate's first read left it.
    const policyAnswers: Array<(policy: PlatformPolicyShape) => void> = [];
    const policyFetch = vi.fn(
      () =>
        new Promise<PlatformPolicyShape>((resolve) => {
          policyAnswers.push(resolve);
        }),
    );
    const policy = new PolicyCache(policyFetch);
    const gateRead = policy.get();
    policyAnswers[0]!(PUBLIC_POLICY);
    await gateRead;
    const { redis, hash } = fakeRedis();
    const store = new RedisLatestConfigVersions({ redis: redis as never });
    // Both processes' polls have since heard the versions the bot holds; the
    // last hints came before the boot.
    await store.recordHint(['botConfig', 'platformPolicy'], T0 - 3_600_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await store.recordPoll({ botConfig: cache.heldVersion()!, platformPolicy: policy.heldVersion()! }, Date.now());
    const middleware = createConfigFreshnessMiddleware(
      deps({ latest: memoiseLatest(() => store.read()), botConfig: () => cache, policy: () => policy }),
    );
    return { cache, fetcher, answers, policy, policyFetch, policyAnswers, redis, hash, store, middleware };
  }

  it('steady state: no panel read per press, and one Redis read for a burst of them', async () => {
    const { fetcher, policyFetch, redis, middleware } = await running();
    const next = vi.fn(async () => undefined);
    for (let update = 0; update < 200; update += 1) {
      await middleware(update % 2 === 0 ? press('help') : message('/start'), next);
    }
    expect(next).toHaveBeenCalledTimes(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(policyFetch).toHaveBeenCalledTimes(1);
    expect(redis.hgetall).toHaveBeenCalledTimes(1);

    // Past the reuse window, one more Redis read — still no panel read.
    await vi.advanceTimersByTimeAsync(1_500);
    for (let update = 0; update < 50; update += 1) await middleware(press('invite'), next);
    expect(redis.hgetall).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(policyFetch).toHaveBeenCalledTimes(1);
  });

  it('an access-mode change the webhook announced: the gate of the next press decides on it; one read', async () => {
    const { policy, policyFetch, policyAnswers, fetcher, store, middleware } = await running();
    // reiwa-api marks the hint; the relay to the bot's `/invalidate-policy` is lost.
    await store.recordHint(['platformPolicy'], Date.now());
    await vi.advanceTimersByTimeAsync(1_500);

    const decided: string[] = [];
    const next = vi.fn(async () => {
      // What the channel gate decides on.
      decided.push((await policy.get()).accessMode);
    });
    const pressed = middleware(press('help'), next);
    await vi.advanceTimersByTimeAsync(0);
    expect(policyFetch).toHaveBeenCalledTimes(2);
    setTimeout(() => policyAnswers[1]!({ ...PUBLIC_POLICY, accessMode: 'RESTRICTED' }), 60);
    await vi.advanceTimersByTimeAsync(60);
    await pressed;
    expect(decided).toEqual(['RESTRICTED']);

    for (let update = 0; update < 20; update += 1) await middleware(press('help'), next);
    await vi.advanceTimersByTimeAsync(1_500);
    for (let update = 0; update < 20; update += 1) await middleware(press('help'), next);
    expect(policyFetch).toHaveBeenCalledTimes(2);
    // The bot config was not behind: not read.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a save the webhook announced: the next press reads it once and is answered from it; the presses after cost nothing', async () => {
    const { cache, fetcher, answers, store, middleware } = await running();
    // reiwa-api marks the hint; the relay to the bot is lost.
    await store.recordHint(['botConfig'], Date.now());
    await vi.advanceTimersByTimeAsync(1_500);

    const next = vi.fn(async () => {
      // What the page renders from.
      rendered.push(await cache.get());
    });
    const rendered: BotConfig[] = [];
    const pressed = middleware(press('help'), next);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    setTimeout(() => answers[1]!(SAVE), 90);
    await vi.advanceTimersByTimeAsync(90);
    await pressed;
    expect(rendered).toEqual([SAVE]);

    for (let update = 0; update < 20; update += 1) await middleware(press('help'), next);
    await vi.advanceTimersByTimeAsync(1_500);
    for (let update = 0; update < 20; update += 1) await middleware(press('help'), next);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
