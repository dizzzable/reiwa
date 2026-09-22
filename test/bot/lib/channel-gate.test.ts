/**
 * The channel gate's decision module (`src/bot/lib/channel-gate.ts`), which the
 * bot and the API both ask:
 *   - resolving the operator's channel reference and the join URL;
 *   - what «Перепроверять подписку» ON and OFF mean for a pass, at an ordinary
 *     update and at a fresh door;
 *   - what each Telegram answer costs: which is remembered, for how long, which
 *     backs the whole chat off, which reaches the operator — once per cause
 *     across processes, through the shared store;
 *   - the deadline on every call, the background writes, a store that fails.
 *
 * Every window is written here as a literal on purpose. Importing the constant
 * would make "the ON-mode pass is trusted for a minute" true of whatever value
 * the constant held.
 *
 * Membership classification is `isSubscribedMember` (`chat-membership.test.ts`).
 * The gate end to end, against grammY's real client, is
 * `test/bot/channel-gate-telegram.test.ts`.
 */
import { GrammyError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isSameChannelChat,
  parseChannelReference,
  resetChannelGateMemory,
  resolveChannelChatId,
  resolveChannelGateVerdict,
  resolveChannelJoinUrl,
  settleChannelGateBackground,
  type ChannelGateDeps,
  type ChannelGateStore,
} from '../../../src/bot/lib/channel-gate.js';
import { MemoryChannelGateStore } from '../../../src/infrastructure/channel-gate/channel-gate-store.js';
import { RedisChannelGateStore } from '../../../src/infrastructure/channel-gate/redis-channel-gate-store.js';
import { FakeRedis } from '../../infrastructure/channel-gate/fake-redis.js';

const CHAT = '-1001234567890';
const STRICT = { channelRequired: true, channelId: CHAT, channelRecheck: true } as const;
const RELAXED = { ...STRICT, channelRecheck: false } as const;

/** 365 days, as a literal. */
const YEAR_MS = 31_536_000_000;
const HOUR_MS = 3_600_000;

beforeEach(() => {
  resetChannelGateMemory();
});

afterEach(() => {
  vi.useRealTimers();
});

function useClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

type MemberAnswer = { readonly status: string; readonly is_member?: boolean };

function telegram(answer: () => MemberAnswer) {
  return { getChatMember: vi.fn(async (_chatId: string, _userId: number): Promise<MemberAnswer> => answer()) };
}

function member(status: string) {
  return telegram(() => ({ status }));
}

function telegramError(code: number, description: string, parameters: Record<string, unknown> = {}): GrammyError {
  return new GrammyError(
    "Call to 'getChatMember' failed!",
    { ok: false, error_code: code, description, parameters },
    'getChatMember',
    {},
  );
}

function refusing(error: unknown) {
  return {
    getChatMember: vi.fn(async (_chatId: string, _userId: number): Promise<MemberAnswer> => {
      throw error;
    }),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function gateDeps(store?: ChannelGateStore, source?: 'api' | 'bot') {
  const reportError = vi.fn().mockResolvedValue({});
  const info = vi.fn();
  const warn = vi.fn();
  const deps: ChannelGateDeps = {
    adminClient: { system: { reportError } } as unknown as ChannelGateDeps['adminClient'],
    logger: {
      fatal: vi.fn(),
      error: vi.fn(),
      warn,
      info,
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    } as unknown as ChannelGateDeps['logger'],
    ...(store !== undefined ? { store } : {}),
    ...(source !== undefined ? { source } : {}),
  };
  return { deps, reportError, info, warn };
}

function spyStore(inner: MemoryChannelGateStore = new MemoryChannelGateStore()) {
  return {
    store: inner,
    hasPass: vi.spyOn(inner, 'hasPass'),
    recordPass: vi.spyOn(inner, 'recordPass'),
    forgetPass: vi.spyOn(inner, 'forgetPass'),
    claimAlert: vi.spyOn(inner, 'claimAlert'),
  };
}

// ── References and links ────────────────────────────────────────────────────

describe('parseChannelReference', () => {
  it('keeps what getChatMember takes: a numeric id or @username', () => {
    expect(parseChannelReference('-1001234567890')).toBe('-1001234567890');
    expect(parseChannelReference(-1001234567890)).toBe('-1001234567890');
    expect(parseChannelReference('@rezeis_news')).toBe('@rezeis_news');
    expect(parseChannelReference(' rezeis_news ')).toBe('@rezeis_news');
  });

  it('reads a public channel link, with or without a scheme, and the app link to a username', () => {
    for (const link of [
      'https://t.me/rezeis_news',
      'http://t.me/rezeis_news/42',
      't.me/rezeis_news',
      'https://t.me/s/rezeis_news',
      'https://telegram.me/rezeis_news?start=x',
      'tg://resolve?domain=rezeis_news',
      'tg://resolve?post=42&domain=rezeis_news',
      'tg:resolve?domain=rezeis_news',
    ]) {
      expect(parseChannelReference(link), link).toBe('@rezeis_news');
    }
  });

  it('refuses what no Bot API call can resolve', () => {
    for (const value of [
      null,
      undefined,
      '',
      '   ',
      'https://t.me/+AbCdEfGhIjk',
      'https://t.me/joinchat/AbCdEfGhIjk',
      'https://t.me/c/1234567890/5',
      'tg://join?invite=AbCdEfGhIjk',
      'https://example.com/t.me/rezeis_news',
      'not-a-link',
    ]) {
      expect(parseChannelReference(value), String(value)).toBeNull();
    }
  });
});

describe('resolveChannelChatId', () => {
  it('reads channelId: null — what rezeis sends for an empty «ID канала» — as not set', () => {
    expect(resolveChannelChatId({ channelId: null, channelLink: 'https://t.me/mychan' })).toBe('@mychan');
    expect(resolveChannelChatId({ channelId: null, channelUsername: null, channelLink: '' })).toBeNull();
    expect(resolveChannelChatId({ channelId: null, channelUsername: '@mychan', channelLink: '' })).toBe('@mychan');
  });

  it('prefers a numeric channelId', () => {
    expect(
      resolveChannelChatId({ channelId: '-1001234567890', channelUsername: '@x', channelLink: 'https://t.me/x' }),
    ).toBe('-1001234567890');
  });

  it('returns null when nothing usable is configured', () => {
    expect(resolveChannelChatId({})).toBeNull();
    expect(resolveChannelChatId({ channelLink: 'https://t.me/+privateInvite' })).toBeNull();
    expect(resolveChannelChatId({ channelLink: 'not-a-link' })).toBeNull();
  });
});

describe('isSameChannelChat', () => {
  it('compares usernames without case, through any form a panel field can hold', () => {
    expect(isSameChannelChat('@Rezeis_News', 'https://t.me/rezeis_news')).toBe(true);
    expect(isSameChannelChat(CHAT, -1001234567890)).toBe(true);
  });

  it('never equates an id with a username, or anything with nothing', () => {
    expect(isSameChannelChat(CHAT, '@rezeis_news')).toBe(false);
    expect(isSameChannelChat(null, null)).toBe(false);
    expect(isSameChannelChat('https://t.me/+invite', 'https://t.me/+invite')).toBe(false);
  });
});

describe('resolveChannelJoinUrl', () => {
  it('passes a web link through as typed, and gives a bare t.me link a scheme', () => {
    expect(resolveChannelJoinUrl({ channelLink: 'https://t.me/mychan' })).toBe('https://t.me/mychan');
    expect(resolveChannelJoinUrl({ channelLink: 'https://t.me/+AbCdEfGhIjk' })).toBe('https://t.me/+AbCdEfGhIjk');
    expect(resolveChannelJoinUrl({ channelLink: 't.me/mychan' })).toBe('https://t.me/mychan');
    expect(resolveChannelJoinUrl({ channelLink: '@mychan' })).toBe('https://t.me/mychan');
  });

  it('turns an app link, with or without the slashes, into the web link the Mini App can open', () => {
    expect(resolveChannelJoinUrl({ channelLink: 'tg://resolve?domain=mychan' })).toBe('https://t.me/mychan');
    expect(resolveChannelJoinUrl({ channelLink: 'tg:resolve?domain=mychan' })).toBe('https://t.me/mychan');
    expect(resolveChannelJoinUrl({ channelLink: 'tg://join?invite=AbCd-Ef_12' })).toBe('https://t.me/+AbCd-Ef_12');
    expect(resolveChannelJoinUrl({ channelLink: 'tg:join?invite=AbCd-Ef_12' })).toBe('https://t.me/+AbCd-Ef_12');
  });

  it('falls back to «Username канала» for an app link with no web twin and for a numeric link', () => {
    expect(resolveChannelJoinUrl({ channelLink: 'tg://privatepost?channel=1&post=2', channelUsername: '@mychan' })).toBe(
      'https://t.me/mychan',
    );
    expect(resolveChannelJoinUrl({ channelLink: '-1001234567890', channelUsername: 'mychan' })).toBe(
      'https://t.me/mychan',
    );
    expect(resolveChannelJoinUrl({ channelLink: '', channelUsername: 'https://t.me/mychan' })).toBe('https://t.me/mychan');
  });

  it('returns null with nothing that opens a channel', () => {
    expect(resolveChannelJoinUrl({})).toBeNull();
    expect(resolveChannelJoinUrl({ channelLink: '-1001234567890' })).toBeNull();
    expect(resolveChannelJoinUrl({ channelLink: 'tg://settings' })).toBeNull();
  });
});

// ── The answer ──────────────────────────────────────────────────────────────

describe('what Telegram says', () => {
  it('is off, and asks nobody, unless «Канал обязателен» is on', async () => {
    const api = member('member');
    expect(await resolveChannelGateVerdict(api, { ...STRICT, channelRequired: false }, 1, gateDeps().deps)).toBe('off');
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it('is off, never a throw, for a policy that is not an object — the admin transport casts the body unvalidated', async () => {
    const api = member('left');
    for (const policy of [null, undefined, 'PUBLIC', 1]) {
      await expect(
        resolveChannelGateVerdict(api, policy as unknown as typeof STRICT, 1, gateDeps().deps),
        String(policy),
      ).resolves.toBe('off');
    }
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it('classifies membership with the canonical predicate', async () => {
    const { deps } = gateDeps();
    let user = 100;
    const verdictFor = async (answer: MemberAnswer): Promise<string> =>
      resolveChannelGateVerdict(telegram(() => answer), STRICT, (user += 1), deps);
    expect(await verdictFor({ status: 'member' })).toBe('subscribed');
    expect(await verdictFor({ status: 'creator' })).toBe('subscribed');
    expect(await verdictFor({ status: 'restricted', is_member: true })).toBe('subscribed');
    expect(await verdictFor({ status: 'restricted', is_member: false })).toBe('not-subscribed');
    expect(await verdictFor({ status: 'left' })).toBe('not-subscribed');
    expect(await verdictFor({ status: 'kicked' })).toBe('not-subscribed');
  });

  it('lets through, without asking, a policy that names no checkable chat — says so once, and claims that alert once per process', async () => {
    const api = member('left');
    const spied = spyStore();
    const { deps, reportError } = gateDeps(spied.store);
    const policy = { channelRequired: true, channelId: null, channelLink: 'https://t.me/+AbCdEfGhIjk' };
    for (let user = 1; user <= 5; user += 1) {
      expect(await resolveChannelGateVerdict(api, policy, user, deps)).toBe('unverified');
    }
    await settleChannelGateBackground();
    expect(api.getChatMember).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(spied.claimAlert).toHaveBeenCalledTimes(1);
  });
});

// ── «Перепроверять подписку» ────────────────────────────────────────────────

describe('«Перепроверять подписку» ON — checked at every entry', () => {
  it('an ordinary update trusts a pass for exactly 60 seconds, in process memory, without reading the store', async () => {
    useClock();
    const api = member('member');
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);

    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('subscribed');
    advance(59_999);
    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);

    advance(1);
    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('subscribed');
    await settleChannelGateBackground();
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
    expect(spied.hasPass).not.toHaveBeenCalled();
    expect(spied.recordPass).not.toHaveBeenCalled();
  });

  it('a fresh door ignores that pass and asks Telegram', async () => {
    useClock();
    let status = 'member';
    const api = telegram(() => ({ status }));
    const { deps } = gateDeps();

    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('subscribed');
    status = 'left';
    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps, { fresh: true })).toBe('not-subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
  });

  it('catches a user who left at the first ordinary check after the minute', async () => {
    useClock();
    let status = 'member';
    const api = telegram(() => ({ status }));
    const { deps } = gateDeps();

    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('subscribed');
    status = 'left';
    advance(30_000);
    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('subscribed');
    advance(30_000);
    expect(await resolveChannelGateVerdict(api, STRICT, 7, deps)).toBe('not-subscribed');
  });

  it('ANY "not subscribed" — ordinary or fresh — forgets the store pass, so switching to OFF cannot bring it back', async () => {
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);
    // Both users passed while the setting was OFF.
    await spied.store.recordPass(CHAT, 8, YEAR_MS);
    await spied.store.recordPass(CHAT, 9, YEAR_MS);
    const api = member('left');

    expect(await resolveChannelGateVerdict(api, STRICT, 8, deps)).toBe('not-subscribed');
    expect(await resolveChannelGateVerdict(api, STRICT, 9, deps, { fresh: true })).toBe('not-subscribed');
    await settleChannelGateBackground();
    expect(spied.forgetPass.mock.calls).toEqual([
      [CHAT, 8],
      [CHAT, 9],
    ]);

    // The operator switches the setting OFF again: neither pass comes back.
    resetChannelGateMemory();
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps)).toBe('not-subscribed');
    expect(await resolveChannelGateVerdict(api, RELAXED, 9, deps, { fresh: true })).toBe('not-subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(4);
  });
});

describe('«Перепроверять подписку» OFF — checked only at the first entry', () => {
  it('records the pass in the store for 365 days, and reads it through a 10-minute memo written on every store hit', async () => {
    useClock();
    const api = member('member');
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);

    // First entry: the store is asked (another process may have let them in), then Telegram.
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps)).toBe('subscribed');
    await settleChannelGateBackground();
    expect(spied.hasPass).toHaveBeenCalledTimes(1);
    expect(spied.recordPass).toHaveBeenCalledWith(CHAT, 8, YEAR_MS);

    advance(599_999);
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps)).toBe('subscribed');
    expect(spied.hasPass).toHaveBeenCalledTimes(1);

    advance(1);
    api.getChatMember.mockImplementation(async () => ({ status: 'left' }));
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps)).toBe('subscribed');
    expect(spied.hasPass).toHaveBeenCalledTimes(2);
    // The store hit is remembered again: the next update does not read Redis.
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps)).toBe('subscribed');
    expect(spied.hasPass).toHaveBeenCalledTimes(2);
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
  });

  it('a fresh door honours a pass this process remembers — and one only the store has — without asking Telegram', async () => {
    const api = member('left');
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);

    expect(await resolveChannelGateVerdict(member('member'), RELAXED, 8, deps)).toBe('subscribed');
    // Left the channel since; «Я подписался», a quest verify, /start: still in — from memory, no store read.
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps, { fresh: true })).toBe('subscribed');
    expect(spied.hasPass).toHaveBeenCalledTimes(1);

    await spied.store.recordPass(CHAT, 9, YEAR_MS);
    expect(await resolveChannelGateVerdict(api, RELAXED, 9, deps, { fresh: true })).toBe('subscribed');
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it('never forgets a pass: a "not subscribed" under OFF deletes nothing', async () => {
    const api = member('left');
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);

    expect(await resolveChannelGateVerdict(api, RELAXED, 10, deps)).toBe('not-subscribed');
    expect(await resolveChannelGateVerdict(api, RELAXED, 11, deps, { fresh: true })).toBe('not-subscribed');
    await settleChannelGateBackground();
    expect(spied.forgetPass).not.toHaveBeenCalled();
  });

  it('a pass outlives a restart: fresh process memory, the same store, no second question', async () => {
    useClock();
    const redis = new FakeRedis();
    const api = member('member');
    const before = gateDeps(new RedisChannelGateStore({ redis: redis.asRedis() }));
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, before.deps)).toBe('subscribed');
    await settleChannelGateBackground();

    resetChannelGateMemory();
    const after = gateDeps(new RedisChannelGateStore({ redis: redis.asRedis() }));
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, after.deps)).toBe('subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
    expect(redis.ttlOf('reiwa:channel-gate:v1:pass:-1001234567890:8')).toBe(YEAR_MS);
  });

  it('pointing «ID канала» at another channel checks everyone again', async () => {
    const api = member('member');
    const { deps } = gateDeps();
    expect(await resolveChannelGateVerdict(api, RELAXED, 8, deps)).toBe('subscribed');
    expect(await resolveChannelGateVerdict(api, { ...RELAXED, channelId: '-1009999999999' }, 8, deps)).toBe('subscribed');
    expect(api.getChatMember.mock.calls.map((call) => call[0])).toEqual([CHAT, '-1009999999999']);
  });

  it('retyping «Username канала» in another case keeps every pass — in process memory and in the store', async () => {
    const api = member('member');
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);
    const byName = { channelRequired: true, channelId: null, channelUsername: '@Rezeis_News', channelRecheck: false };

    expect(await resolveChannelGateVerdict(api, byName, 12, deps)).toBe('subscribed');
    await settleChannelGateBackground();
    // This process remembers it under the lower-case name…
    expect(await resolveChannelGateVerdict(api, { ...byName, channelUsername: 'rezeis_news' }, 12, deps)).toBe(
      'subscribed',
    );
    // …and so does the store, which another process (fresh memory) reads.
    resetChannelGateMemory();
    expect(await resolveChannelGateVerdict(api, { ...byName, channelUsername: '@REZEIS_NEWS' }, 12, deps)).toBe(
      'subscribed',
    );
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
    // The first entry and the "other process" read the store; the same-process retype did not.
    expect(spied.hasPass).toHaveBeenCalledTimes(2);
  });
});

// ── What each answer costs ──────────────────────────────────────────────────

describe('load: one Telegram call where many updates ask', () => {
  it('ordinary checks of one user share one call', async () => {
    const answer = deferred<MemberAnswer>();
    const api = { getChatMember: vi.fn(() => answer.promise) };
    const { deps } = gateDeps();

    const first = resolveChannelGateVerdict(api, STRICT, 9, deps);
    const second = resolveChannelGateVerdict(api, STRICT, 9, deps);
    await vi.waitFor(() => expect(api.getChatMember).toHaveBeenCalledTimes(1));
    answer.resolve({ status: 'member' });

    expect(await Promise.all([first, second])).toEqual(['subscribed', 'subscribed']);
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
  });

  it('a fresh door never takes the answer to a running ordinary call — but fresh doors share theirs', async () => {
    const answers = [deferred<MemberAnswer>(), deferred<MemberAnswer>()];
    let call = 0;
    const api = { getChatMember: vi.fn(() => answers[call++].promise) };
    const { deps } = gateDeps();

    const ordinary = resolveChannelGateVerdict(api, STRICT, 9, deps);
    await vi.waitFor(() => expect(api.getChatMember).toHaveBeenCalledTimes(1));
    const fresh = resolveChannelGateVerdict(api, STRICT, 9, deps, { fresh: true });
    await vi.waitFor(() => expect(api.getChatMember).toHaveBeenCalledTimes(2));
    const secondFresh = resolveChannelGateVerdict(api, STRICT, 9, deps, { fresh: true });
    const laterOrdinary = resolveChannelGateVerdict(api, STRICT, 9, deps);

    // The first call was issued before the user joined; the fresh one after.
    answers[0].resolve({ status: 'left' });
    answers[1].resolve({ status: 'member' });
    expect(await ordinary).toBe('not-subscribed');
    expect(await Promise.all([fresh, secondFresh, laterOrdinary])).toEqual(['subscribed', 'subscribed', 'subscribed']);
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
  });

  it('an ordinary update remembers "not subscribed" for exactly 10 seconds', async () => {
    useClock();
    const api = member('left');
    const { deps } = gateDeps();

    expect(await resolveChannelGateVerdict(api, STRICT, 10, deps)).toBe('not-subscribed');
    advance(9_999);
    expect(await resolveChannelGateVerdict(api, STRICT, 10, deps)).toBe('not-subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await resolveChannelGateVerdict(api, STRICT, 10, deps)).toBe('not-subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
  });

  it('a remembered verdict answers before a back-off does', async () => {
    let refuse = false;
    const api = {
      getChatMember: vi.fn(async (_chat: string, userId: number): Promise<MemberAnswer> => {
        if (refuse) throw telegramError(400, 'Bad Request: member list is inaccessible');
        return { status: userId === 20 ? 'left' : 'member' };
      }),
    };
    const { deps } = gateDeps();
    expect(await resolveChannelGateVerdict(api, STRICT, 20, deps)).toBe('not-subscribed');
    expect(await resolveChannelGateVerdict(api, STRICT, 21, deps)).toBe('subscribed');

    refuse = true;
    expect(await resolveChannelGateVerdict(api, STRICT, 22, deps)).toBe('unverified');
    // The chat is backed off now — and the two users it already had an answer for keep it.
    expect(await resolveChannelGateVerdict(api, STRICT, 20, deps)).toBe('not-subscribed');
    expect(await resolveChannelGateVerdict(api, STRICT, 21, deps)).toBe('subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(3);
  });

  it('under OFF, a back-off or a refusal answers before the store is read', async () => {
    const spied = spyStore();
    const { deps } = gateDeps(spied.store);
    const api = refusing(new Error('socket hang up'));

    expect(await resolveChannelGateVerdict(api, RELAXED, 23, deps)).toBe('unverified');
    expect(spied.hasPass).toHaveBeenCalledTimes(1);
    expect(await resolveChannelGateVerdict(api, RELAXED, 24, deps)).toBe('unverified');
    expect(await resolveChannelGateVerdict(api, RELAXED, 25, deps, { fresh: true })).toBe('unverified');
    expect(spied.hasPass).toHaveBeenCalledTimes(1);
  });
});

describe('refusals: about the user, about the chat, and words nobody recognises', () => {
  it('a refusal about the user lets that user in for exactly 60 seconds — logged, never alerted', async () => {
    useClock();
    for (const description of [
      'Bad Request: user not found',
      'Bad Request: member not found',
      'Bad Request: PARTICIPANT_ID_INVALID',
      'Bad Request: USER_ID_INVALID',
      'Bad Request: PEER_ID_INVALID',
      'Bad Request: invalid user_id specified',
    ]) {
      resetChannelGateMemory();
      const api = refusing(telegramError(400, description));
      const { deps, reportError, info, warn } = gateDeps();

      expect(await resolveChannelGateVerdict(api, STRICT, 30, deps), description).toBe('unverified');
      advance(59_999);
      expect(await resolveChannelGateVerdict(api, STRICT, 30, deps), description).toBe('unverified');
      expect(api.getChatMember, description).toHaveBeenCalledTimes(1);
      // About one user, not the chat: the next user is still asked about.
      expect(await resolveChannelGateVerdict(api, STRICT, 31, deps), description).toBe('unverified');
      expect(api.getChatMember, description).toHaveBeenCalledTimes(2);
      expect(info, description).toHaveBeenCalledTimes(1);

      advance(1);
      await resolveChannelGateVerdict(api, STRICT, 30, deps);
      await settleChannelGateBackground();
      expect(api.getChatMember, description).toHaveBeenCalledTimes(3);
      expect(reportError, description).not.toHaveBeenCalled();
      expect(warn, description).not.toHaveBeenCalled();
    }
  });

  it('a refusal about the chat backs everyone off 5 s, 60 s while it repeats within 2 minutes, then 5 s again', async () => {
    useClock();
    const api = refusing(telegramError(400, 'Bad Request: member list is inaccessible'));
    const { deps } = gateDeps();
    const calls = (): number => api.getChatMember.mock.calls.length;

    await resolveChannelGateVerdict(api, STRICT, 1, deps);
    advance(4_999);
    expect(await resolveChannelGateVerdict(api, STRICT, 2, deps)).toBe('unverified');
    expect(calls()).toBe(1);
    advance(1);
    await resolveChannelGateVerdict(api, STRICT, 3, deps);
    expect(calls()).toBe(2);

    advance(59_999);
    await resolveChannelGateVerdict(api, STRICT, 4, deps);
    expect(calls()).toBe(2);
    advance(1);
    await resolveChannelGateVerdict(api, STRICT, 5, deps);
    expect(calls()).toBe(3);

    // Two minutes with no refusal: the next one is a first one again.
    advance(120_000);
    await resolveChannelGateVerdict(api, STRICT, 6, deps);
    expect(calls()).toBe(4);
    advance(4_999);
    await resolveChannelGateVerdict(api, STRICT, 7, deps);
    expect(calls()).toBe(4);
    advance(1);
    await resolveChannelGateVerdict(api, STRICT, 8, deps);
    expect(calls()).toBe(5);
  });

  it('every refusal wording known to be about the chat alerts the operator', async () => {
    for (const [code, description] of [
      [400, 'Bad Request: member list is inaccessible'],
      [400, 'Bad Request: chat not found'],
      [400, 'Bad Request: CHAT_ADMIN_REQUIRED'],
      [400, 'Bad Request: not enough rights to get chat member'],
      [400, 'Bad Request: need administrator rights in the channel chat'],
      [403, 'Forbidden: bot is not a member of the channel chat'],
      [403, 'Forbidden: bot was kicked from the channel chat'],
      [400, 'Bad Request: CHANNEL_PRIVATE'],
      [400, 'Bad Request: CHANNEL_INVALID'],
    ] as const) {
      resetChannelGateMemory();
      const api = refusing(telegramError(code, description));
      const { deps, reportError } = gateDeps();
      expect(await resolveChannelGateVerdict(api, STRICT, 1, deps), description).toBe('unverified');
      expect(await resolveChannelGateVerdict(api, STRICT, 2, deps), description).toBe('unverified');
      await settleChannelGateBackground();
      expect(api.getChatMember, description).toHaveBeenCalledTimes(1);
      expect(reportError, description).toHaveBeenCalledTimes(1);
      const report = reportError.mock.calls[0][0] as { message: string; level: string; source: string };
      expect(report, description).toMatchObject({ level: 'warning', source: 'bot' });
      expect(report.message, description).toContain('administrator');
    }
  });

  it('words nobody recognises are about the user — until a second user gets them within 10 minutes', async () => {
    useClock();
    const unknown = telegramError(400, 'Bad Request: a refusal Telegram invented next year');
    const api = refusing(unknown);
    const { deps, reportError } = gateDeps();

    expect(await resolveChannelGateVerdict(api, STRICT, 1, deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(reportError).not.toHaveBeenCalled();
    // The same user again, past their memo: still about them.
    advance(60_000);
    expect(await resolveChannelGateVerdict(api, STRICT, 1, deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(reportError).not.toHaveBeenCalled();
    expect(api.getChatMember).toHaveBeenCalledTimes(2);

    // A second user, inside the window: about the chat — back-off and alert.
    advance(10 * 60_000 - 60_001);
    expect(await resolveChannelGateVerdict(api, STRICT, 2, deps)).toBe('unverified');
    expect(await resolveChannelGateVerdict(api, STRICT, 3, deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(api.getChatMember).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('the 10-minute window for unrecognised words starts at their first sighting', async () => {
    useClock();
    const api = refusing(telegramError(400, 'Bad Request: another new wording'));
    const { deps, reportError } = gateDeps();

    await resolveChannelGateVerdict(api, STRICT, 1, deps);
    advance(10 * 60_000);
    // First user's sighting has expired: this is a first sighting again.
    expect(await resolveChannelGateVerdict(api, STRICT, 2, deps)).toBe('unverified');
    expect(await resolveChannelGateVerdict(api, STRICT, 3, deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(api.getChatMember).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('one misconfiguration is ONE operator alert for two processes sharing Redis — and the losing process does not keep claiming', async () => {
    useClock();
    const redis = new FakeRedis();
    const api = refusing(telegramError(400, 'Bad Request: member list is inaccessible'));
    const bot = gateDeps(new RedisChannelGateStore({ redis: redis.asRedis() }));
    expect(await resolveChannelGateVerdict(api, STRICT, 1, bot.deps)).toBe('unverified');
    await settleChannelGateBackground();

    // A second process: its own memory, its own store, the same Redis.
    resetChannelGateMemory();
    const apiProcess = gateDeps(new RedisChannelGateStore({ redis: redis.asRedis() }), 'api');
    const claimsBefore = redis.calls.filter((call) => call.args.includes('NX')).length;
    expect(await resolveChannelGateVerdict(api, STRICT, 2, apiProcess.deps)).toBe('unverified');
    advance(5_000);
    expect(await resolveChannelGateVerdict(api, STRICT, 3, apiProcess.deps)).toBe('unverified');
    await settleChannelGateBackground();

    expect(api.getChatMember).toHaveBeenCalledTimes(3);
    expect(bot.reportError).toHaveBeenCalledTimes(1);
    expect(apiProcess.reportError).not.toHaveBeenCalled();
    expect(redis.calls.filter((call) => call.args.includes('NX')).length - claimsBefore).toBe(1);
  });

  it('the operator hears about it again after exactly an hour, not before', async () => {
    useClock();
    const api = refusing(telegramError(400, 'Bad Request: member list is inaccessible'));
    const { deps, reportError } = gateDeps();

    await resolveChannelGateVerdict(api, STRICT, 1, deps);
    await settleChannelGateBackground();
    expect(reportError).toHaveBeenCalledTimes(1);

    advance(HOUR_MS - 6_000);
    await resolveChannelGateVerdict(api, STRICT, 2, deps);
    await settleChannelGateBackground();
    expect(reportError).toHaveBeenCalledTimes(1);

    advance(6_000);
    await resolveChannelGateVerdict(api, STRICT, 3, deps);
    await settleChannelGateBackground();
    expect(api.getChatMember).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it('429: nobody in that chat is asked about until retry_after — capped at 60 s, 5 s when absent — even without the 429 code', async () => {
    useClock();
    for (const [code, parameters, waitMs] of [
      [429, { retry_after: 7 }, 7_000],
      [429, { retry_after: 3_600 }, 60_000],
      [429, {}, 5_000],
      [400, { retry_after: 9 }, 9_000],
    ] as const) {
      resetChannelGateMemory();
      const label = `${code} ${JSON.stringify(parameters)}`;
      const api = refusing(telegramError(code, 'Too Many Requests: retry after N', parameters));
      const { deps, reportError } = gateDeps();

      expect(await resolveChannelGateVerdict(api, STRICT, 1, deps), label).toBe('unverified');
      advance(waitMs - 1);
      expect(await resolveChannelGateVerdict(api, STRICT, 2, deps), label).toBe('unverified');
      expect(api.getChatMember, label).toHaveBeenCalledTimes(1);
      advance(1);
      await resolveChannelGateVerdict(api, STRICT, 3, deps);
      await settleChannelGateBackground();
      expect(api.getChatMember, label).toHaveBeenCalledTimes(2);
      expect(reportError, label).not.toHaveBeenCalled();
    }
  });

  it('a back-off never shortens: a 60 s flood-wait survives a network failure asking for 5 s', async () => {
    useClock();
    const answers = new Map([
      [1, deferred<MemberAnswer>()],
      [2, deferred<MemberAnswer>()],
    ]);
    const api = { getChatMember: vi.fn((_chat: string, userId: number) => answers.get(userId)?.promise ?? Promise.resolve({ status: 'member' })) };
    const { deps } = gateDeps();

    const flooded = resolveChannelGateVerdict(api, STRICT, 1, deps);
    const unreachable = resolveChannelGateVerdict(api, STRICT, 2, deps);
    await vi.waitFor(() => expect(api.getChatMember).toHaveBeenCalledTimes(2));
    answers.get(1)?.reject(telegramError(429, 'Too Many Requests: retry after 60', { retry_after: 60 }));
    expect(await flooded).toBe('unverified');
    answers.get(2)?.reject(new Error('socket hang up'));
    expect(await unreachable).toBe('unverified');

    advance(59_999);
    expect(await resolveChannelGateVerdict(api, STRICT, 3, deps)).toBe('unverified');
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
  });
});

describe('Telegram not answering', () => {
  it('a network failure backs the chat off for 5 s, logged once', async () => {
    useClock();
    const api = refusing(new Error('socket hang up'));
    const { deps, warn, reportError } = gateDeps();

    expect(await resolveChannelGateVerdict(api, STRICT, 1, deps)).toBe('unverified');
    advance(4_999);
    expect(await resolveChannelGateVerdict(api, STRICT, 2, deps)).toBe('unverified');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await resolveChannelGateVerdict(api, STRICT, 3, deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('gives up after 6 seconds, whatever client was passed — a network failure, not the operator’s fault', async () => {
    vi.useFakeTimers();
    const api = { getChatMember: vi.fn(() => new Promise<MemberAnswer>(() => undefined)) };
    const { deps, reportError } = gateDeps();

    let verdict: string | undefined;
    void resolveChannelGateVerdict(api, STRICT, 1, deps).then((value) => (verdict = value));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toBe('unverified');
    await settleChannelGateBackground();
    expect(reportError).not.toHaveBeenCalled();

    // …and treats it as one: the chat is not asked again at once.
    expect(await resolveChannelGateVerdict(api, STRICT, 2, deps)).toBe('unverified');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
  });

  it('leaves no deadline timer behind once Telegram has answered', async () => {
    vi.useFakeTimers();
    const { deps } = gateDeps();
    expect(await resolveChannelGateVerdict(member('member'), STRICT, 1, deps)).toBe('subscribed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a fresh door asks at most once per 2 seconds', () => {
  it('reuses its last answer within the window, and asks again at exactly 2 seconds', async () => {
    useClock();
    const api = member('left');
    const { deps } = gateDeps();

    expect(await resolveChannelGateVerdict(api, STRICT, 41, deps, { fresh: true })).toBe('not-subscribed');
    advance(1_999);
    expect(await resolveChannelGateVerdict(api, STRICT, 41, deps, { fresh: true })).toBe('not-subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
    advance(1);
    await resolveChannelGateVerdict(api, STRICT, 41, deps, { fresh: true });
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
  });

  it('skips a remembered "not subscribed", and still honours a back-off', async () => {
    let status = 'left';
    const api = telegram(() => ({ status }));
    const { deps } = gateDeps();
    expect(await resolveChannelGateVerdict(api, STRICT, 42, deps)).toBe('not-subscribed');
    status = 'member';
    expect(await resolveChannelGateVerdict(api, STRICT, 42, deps, { fresh: true })).toBe('subscribed');

    const refused = refusing(telegramError(400, 'Bad Request: member list is inaccessible'));
    await resolveChannelGateVerdict(refused, STRICT, 43, deps);
    expect(await resolveChannelGateVerdict(refused, STRICT, 44, deps, { fresh: true })).toBe('unverified');
    expect(refused.getChatMember).toHaveBeenCalledTimes(1);
  });
});

// ── The store ───────────────────────────────────────────────────────────────

describe('the store on the update path', () => {
  it('a store write that never finishes does not hold the decision', async () => {
    const stuck: ChannelGateStore = {
      hasPass: async () => false,
      recordPass: () => new Promise<void>(() => undefined),
      forgetPass: () => new Promise<void>(() => undefined),
      claimAlert: () => new Promise<boolean>(() => undefined),
    };
    const { deps } = gateDeps(stuck);

    expect(await resolveChannelGateVerdict(member('member'), RELAXED, 50, deps)).toBe('subscribed');
    expect(await resolveChannelGateVerdict(member('left'), STRICT, 51, deps)).toBe('not-subscribed');
    expect(
      await resolveChannelGateVerdict(refusing(telegramError(400, 'Bad Request: chat not found')), STRICT, 52, deps),
    ).toBe('unverified');
  });

  it('a Redis that is reconnecting costs no command at all', async () => {
    const redis = new FakeRedis();
    redis.status = 'reconnecting';
    const { deps } = gateDeps(new RedisChannelGateStore({ redis: redis.asRedis() }));

    expect(await resolveChannelGateVerdict(member('member'), RELAXED, 53, deps)).toBe('subscribed');
    expect(await resolveChannelGateVerdict(member('left'), RELAXED, 54, deps, { fresh: true })).toBe('not-subscribed');
    await settleChannelGateBackground();
    expect(redis.calls).toEqual([]);
  });

  it('a store that breaks its promise and rejects is answered from process memory, and said so once per operation', async () => {
    useClock();
    const broken: ChannelGateStore = {
      hasPass: vi.fn(async () => Promise.reject(new Error('store down'))),
      recordPass: vi.fn(async () => Promise.reject(new Error('store down'))),
      forgetPass: vi.fn(async () => Promise.reject(new Error('store down'))),
      claimAlert: vi.fn(async () => Promise.reject(new Error('store down'))),
    };
    const api = member('member');
    const { deps, warn } = gateDeps(broken);
    const operations = (): Array<string | undefined> =>
      warn.mock.calls.map((args) => (args[0] as { operation?: string }).operation);

    expect(await resolveChannelGateVerdict(api, RELAXED, 55, deps)).toBe('subscribed');
    expect(await resolveChannelGateVerdict(api, RELAXED, 56, deps)).toBe('subscribed');
    await settleChannelGateBackground();
    expect(operations()).toEqual(['hasPass', 'recordPass']);

    // Past the memo the pass is read from the store — which rejects — and found in memory.
    advance(600_000);
    expect(await resolveChannelGateVerdict(api, RELAXED, 55, deps)).toBe('subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(2);
    expect(operations()).toEqual(['hasPass', 'recordPass', 'hasPass']);
  });
});

describe('reporting', () => {
  it('reports a refusal under the surface that met it', async () => {
    const api = refusing(telegramError(400, 'Bad Request: member list is inaccessible'));
    const fromApi = gateDeps(undefined, 'api');
    expect(await resolveChannelGateVerdict(api, STRICT, 11, fromApi.deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(fromApi.reportError).toHaveBeenCalledWith(expect.objectContaining({ source: 'api' }));

    resetChannelGateMemory();
    const fromBot = gateDeps();
    expect(await resolveChannelGateVerdict(api, STRICT, 12, fromBot.deps)).toBe('unverified');
    await settleChannelGateBackground();
    expect(fromBot.reportError).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'bot' }));
  });

  it('a report that cannot be filed does not fail the decision', async () => {
    const api = refusing(telegramError(400, 'Bad Request: chat not found'));
    const deps: ChannelGateDeps = { adminClient: {} as unknown as ChannelGateDeps['adminClient'] };
    await expect(resolveChannelGateVerdict(api, STRICT, 13, deps)).resolves.toBe('unverified');
    await expect(settleChannelGateBackground()).resolves.toBeUndefined();
  });
});

// ── «Проверять только новых» ─────────────────────────────────────────────────

describe('«Проверять только новых»', () => {
  const SINCE = '2026-09-22T09:00:00.000Z';
  const NEW_ONLY = { ...STRICT, channelNewUsersSince: SINCE } as const;
  const OLD_ACCOUNT = { exists: true, createdAt: '2026-01-01T00:00:00.000Z' } as const;

  type ExistsAnswer = { readonly exists: boolean; readonly createdAt?: string | null };

  function withAccount(answer: () => Promise<ExistsAnswer>) {
    const base = gateDeps();
    const lookup = vi.fn(async (_identity: { readonly telegramId?: string }) => answer());
    const deps: ChannelGateDeps = {
      ...base.deps,
      adminClient: {
        system: { reportError: base.reportError },
        user: { exists: lookup },
      } as unknown as ChannelGateDeps['adminClient'],
    };
    return { deps, lookup, warn: base.warn };
  }

  it('lets an account created before the moment in, without asking Telegram', async () => {
    const api = member('left');
    const { deps, lookup } = withAccount(async () => OLD_ACCOUNT);
    expect(await resolveChannelGateVerdict(api, NEW_ONLY, 42, deps)).toBe('exempt');
    expect(api.getChatMember).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith({ telegramId: '42' });
  });

  it('asks an account created at or after the moment exactly as before', async () => {
    // ANTI-VACUITY for the one above: the same user, the same «left», one
    // account that is new — at the moment itself, which counts as new.
    const api = member('left');
    const { deps } = withAccount(async () => ({ exists: true, createdAt: SINCE }));
    expect(await resolveChannelGateVerdict(api, NEW_ONLY, 42, deps)).toBe('not-subscribed');
    expect(api.getChatMember).toHaveBeenCalledTimes(1);
  });

  it('keeps an old account in at a fresh door too: it is outside the gate, not a member who left', async () => {
    // «Я подписался» and the Mini App's POST ask Telegram afresh under
    // «Перепроверять подписку» ON. An old account must not be walled in by them
    // after unsubscribing — that is the whole point of the switch.
    const api = member('left');
    const { deps } = withAccount(async () => OLD_ACCOUNT);
    expect(await resolveChannelGateVerdict(api, NEW_ONLY, 42, deps, { fresh: true })).toBe('exempt');
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it('asks a Telegram user with no account yet: until /start creates one, they are new', async () => {
    const api = member('left');
    const { deps } = withAccount(async () => ({ exists: false, createdAt: null }));
    expect(await resolveChannelGateVerdict(api, NEW_ONLY, 42, deps)).toBe('not-subscribed');
  });

  it('only ever relaxes: a panel that fails, or predates the field, changes nothing', async () => {
    const failing = withAccount(async () => {
      throw new Error('panel down');
    });
    expect(await resolveChannelGateVerdict(member('left'), NEW_ONLY, 42, failing.deps)).toBe('not-subscribed');
    expect(failing.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('«Проверять только новых» asks it as usual'),
    );

    // A panel before 22.09.2026 answers `exists` without the date.
    const olderPanel = withAccount(async () => ({ exists: true }));
    expect(await resolveChannelGateVerdict(member('left'), NEW_ONLY, 43, olderPanel.deps)).toBe('not-subscribed');
  });

  it('treats a panel that stalls past 3 s as unable to date the account', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { deps } = withAccount(() => new Promise<ExistsAnswer>(() => undefined));
    const verdict = resolveChannelGateVerdict(member('left'), NEW_ONLY, 42, deps);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await verdict).toBe('not-subscribed');
  });

  it('asks the panel once per account, not once per update', async () => {
    const api = member('left');
    const { deps, lookup } = withAccount(async () => OLD_ACCOUNT);
    const concurrent = await Promise.all([
      resolveChannelGateVerdict(api, NEW_ONLY, 42, deps),
      resolveChannelGateVerdict(api, NEW_ONLY, 42, deps),
      resolveChannelGateVerdict(api, NEW_ONLY, 42, deps),
    ]);
    expect(concurrent).toEqual(['exempt', 'exempt', 'exempt']);
    expect(await resolveChannelGateVerdict(api, NEW_ONLY, 42, deps)).toBe('exempt');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the account again when the operator moves the moment', async () => {
    // The moment is part of what is remembered: created 1 September is OLD
    // against 22 September and NEW against 1 August.
    const api = member('left');
    const { deps, lookup } = withAccount(async () => ({ exists: true, createdAt: '2026-09-01T00:00:00.000Z' }));
    expect(await resolveChannelGateVerdict(api, NEW_ONLY, 42, deps)).toBe('exempt');
    const earlier = { ...STRICT, channelNewUsersSince: '2026-08-01T00:00:00.000Z' } as const;
    expect(await resolveChannelGateVerdict(api, earlier, 42, deps)).toBe('not-subscribed');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('never asks the panel while the switch is off', async () => {
    const { deps, lookup } = withAccount(async () => OLD_ACCOUNT);
    expect(await resolveChannelGateVerdict(member('member'), STRICT, 42, deps)).toBe('subscribed');
    expect(await resolveChannelGateVerdict(member('member'), { ...STRICT, channelNewUsersSince: null }, 43, deps)).toBe(
      'subscribed',
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
