/**
 * channel-gate helper specs.
 *
 * Pure helpers shared by the /start gate and the check_channel callback:
 *   - chat-id resolution is total and prefers numeric id → @username → link
 *   - join URL derivation from link / username
 *   - membership status classification
 *   - gate-active predicate
 *   - relaxed-mode passed-gate memory with TTL semantics
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveChannelChatId,
  resolveChannelJoinUrl,
  isSubscribedStatus,
  isChannelGateActive,
  markChannelPassed,
  hasRecentlyPassedChannel,
  resetChannelGateMemory,
} from '../../../src/bot/lib/channel-gate.js';

afterEach(() => resetChannelGateMemory());

describe('resolveChannelChatId', () => {
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
  });
  it('returns null with nothing set', () => {
    expect(resolveChannelJoinUrl({})).toBeNull();
  });
});

describe('isSubscribedStatus', () => {
  it('treats member/administrator/creator/restricted as subscribed', () => {
    for (const s of ['member', 'administrator', 'creator', 'restricted']) {
      expect(isSubscribedStatus(s)).toBe(true);
    }
  });
  it('treats left/kicked as not subscribed', () => {
    expect(isSubscribedStatus('left')).toBe(false);
    expect(isSubscribedStatus('kicked')).toBe(false);
  });
});

describe('isChannelGateActive', () => {
  it('is active only when required AND a channel is resolvable', () => {
    expect(isChannelGateActive({ channelRequired: true, channelId: '-100' })).toBe(true);
    expect(isChannelGateActive({ channelRequired: true })).toBe(false);
    expect(isChannelGateActive({ channelRequired: false, channelId: '-100' })).toBe(false);
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
