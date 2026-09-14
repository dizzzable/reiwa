/**
 * channel-gate helper specs.
 *
 * Pure helpers shared by the /start gate and the check_channel callback:
 *   - chat-id resolution is total and prefers numeric id → @username → link
 *   - join URL derivation from link / username
 *   - the membership check: off / subscribed / not-subscribed / unverified
 *   - relaxed-mode passed-gate memory with TTL semantics
 *
 * Membership classification is `isSubscribedMember` (`chat-membership.test.ts`);
 * the gate's own copy counted `restricted` as subscribed even with
 * `is_member: false`. The gate end to end, against grammY's real client, is
 * `test/bot/channel-gate-telegram.test.ts`.
 */
import { GrammyError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseChannelReference,
  resolveChannelChatId,
  resolveChannelJoinUrl,
  checkChannelMembership,
  markChannelPassed,
  hasRecentlyPassedChannel,
  resetChannelGateMemory,
} from '../../../src/bot/lib/channel-gate.js';

afterEach(() => resetChannelGateMemory());

describe('parseChannelReference', () => {
  it('keeps what getChatMember takes: a numeric id or @username', () => {
    expect(parseChannelReference('-1001234567890')).toBe('-1001234567890');
    expect(parseChannelReference(-1001234567890)).toBe('-1001234567890');
    expect(parseChannelReference('@rezeis_news')).toBe('@rezeis_news');
    expect(parseChannelReference(' rezeis_news ')).toBe('@rezeis_news');
  });

  it('reads a public channel link, with or without a scheme', () => {
    for (const link of [
      'https://t.me/rezeis_news',
      'http://t.me/rezeis_news/42',
      't.me/rezeis_news',
      'https://t.me/s/rezeis_news',
      'https://telegram.me/rezeis_news?start=x',
    ]) {
      expect(parseChannelReference(link)).toBe('@rezeis_news');
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
      'https://example.com/t.me/rezeis_news',
      'not-a-link',
    ]) {
      expect(parseChannelReference(value)).toBeNull();
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

  it('normalises a bare username to @form', () => {
    expect(resolveChannelChatId({ channelUsername: 'mychan' })).toBe('@mychan');
    expect(resolveChannelChatId({ channelUsername: '@mychan' })).toBe('@mychan');
  });

  it('extracts @username from a t.me link', () => {
    expect(resolveChannelChatId({ channelLink: 'https://t.me/mychan' })).toBe('@mychan');
  });

  it('returns null when nothing usable is configured', () => {
    expect(resolveChannelChatId({})).toBeNull();
    // A private invite link (t.me/+hash) has no public @username → unresolvable.
    expect(resolveChannelChatId({ channelLink: 'https://t.me/+privateInvite' })).toBeNull();
    expect(resolveChannelChatId({ channelLink: 'not-a-link' })).toBeNull();
  });
});

describe('resolveChannelJoinUrl', () => {
  it('builds a t.me URL from a @username link', () => {
    expect(resolveChannelJoinUrl({ channelLink: '@mychan' })).toBe('https://t.me/mychan');
  });
  it('passes through an https link', () => {
    expect(resolveChannelJoinUrl({ channelLink: 'https://t.me/mychan' })).toBe('https://t.me/mychan');
  });
  it('falls back to channelUsername', () => {
    expect(resolveChannelJoinUrl({ channelUsername: '@mychan' })).toBe('https://t.me/mychan');
    expect(resolveChannelJoinUrl({ channelLink: '', channelUsername: 'https://t.me/mychan' })).toBe(
      'https://t.me/mychan',
    );
  });
  it('keeps a private invite link as the join button and gives a bare t.me link a scheme', () => {
    expect(resolveChannelJoinUrl({ channelLink: 'https://t.me/+AbCdEfGhIjk' })).toBe('https://t.me/+AbCdEfGhIjk');
    expect(resolveChannelJoinUrl({ channelLink: 't.me/mychan' })).toBe('https://t.me/mychan');
  });
  it('returns null with nothing set', () => {
    expect(resolveChannelJoinUrl({})).toBeNull();
  });
});

describe('checkChannelMembership', () => {
  const noDeps = { adminClient: null };

  it('is off, and asks nobody, unless «Канал обязателен» is on', async () => {
    const api = { getChatMember: vi.fn() };
    expect(await checkChannelMembership(api, { channelRequired: false, channelId: '-100' }, 1, noDeps)).toBe('off');
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it('classifies what Telegram answers with the canonical membership predicate', async () => {
    const policy = { channelRequired: true, channelId: '-1001234567890' };
    const answer = async (member: object): Promise<string> =>
      checkChannelMembership({ getChatMember: vi.fn().mockResolvedValue(member) }, policy, 1, noDeps);
    expect(await answer({ status: 'member' })).toBe('subscribed');
    expect(await answer({ status: 'creator' })).toBe('subscribed');
    expect(await answer({ status: 'restricted', is_member: true })).toBe('subscribed');
    expect(await answer({ status: 'restricted', is_member: false })).toBe('not-subscribed');
    expect(await answer({ status: 'left' })).toBe('not-subscribed');
    expect(await answer({ status: 'kicked' })).toBe('not-subscribed');
  });

  it('lets through, without asking, a policy that names no checkable chat', async () => {
    const api = { getChatMember: vi.fn() };
    const policy = { channelRequired: true, channelId: null, channelLink: 'https://t.me/+AbCdEfGhIjk' };
    expect(await checkChannelMembership(api, policy, 1, noDeps)).toBe('unverified');
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it('lets through on every failure, but reports only a Telegram refusal, not a network failure', async () => {
    const warn = vi.fn();
    const reportError = vi.fn().mockResolvedValue({});
    const deps = {
      adminClient: { system: { reportError } } as unknown as Parameters<typeof checkChannelMembership>[3]['adminClient'],
      logger: { warn } as unknown as Parameters<typeof checkChannelMembership>[3]['logger'],
    };
    const policy = { channelRequired: true, channelId: '-1001234567890' };
    const refusal = new GrammyError(
      "Call to 'getChatMember' failed!",
      { ok: false, error_code: 400, description: 'Bad Request: member list is inaccessible' },
      'getChatMember',
      {},
    );

    // The positive control first, through the same deps: without it the
    // "not reported" below would also pass if the report went nowhere.
    const refused = { getChatMember: vi.fn().mockRejectedValue(refusal) };
    expect(await checkChannelMembership(refused, policy, 1, deps)).toBe('unverified');
    expect(reportError).toHaveBeenCalledTimes(1);

    const unreachable = { getChatMember: vi.fn().mockRejectedValue(new Error('socket hang up')) };
    expect(await checkChannelMembership(unreachable, policy, 2, deps)).toBe('unverified');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('passed-gate memory', () => {
  it('records and reports a recently-passed user', () => {
    expect(hasRecentlyPassedChannel(42)).toBe(false);
    markChannelPassed(42);
    expect(hasRecentlyPassedChannel(42)).toBe(true);
  });
  it('reset clears the memory', () => {
    markChannelPassed(7);
    resetChannelGateMemory();
    expect(hasRecentlyPassedChannel(7)).toBe(false);
  });
});
