/**
 * Canonical Telegram chat-membership predicate — the single fail-closed rule
 * that decides whether a getChatMember result counts as "subscribed" for quest
 * reward eligibility. Shared by the strict channel callback and the periodic
 * recheck loop so the two can never drift.
 */
import { describe, expect, it } from 'vitest';

import { isSubscribedMember } from '../../../src/bot/lib/chat-membership.js';

describe('isSubscribedMember', () => {
  it('accepts member / administrator / creator', () => {
    expect(isSubscribedMember({ status: 'member' })).toBe(true);
    expect(isSubscribedMember({ status: 'administrator' })).toBe(true);
    expect(isSubscribedMember({ status: 'creator' })).toBe(true);
  });

  it('accepts restricted ONLY when still a member', () => {
    expect(isSubscribedMember({ status: 'restricted', is_member: true })).toBe(true);
    expect(isSubscribedMember({ status: 'restricted', is_member: false })).toBe(false);
    expect(isSubscribedMember({ status: 'restricted' })).toBe(false);
  });

  it('rejects left / kicked / unknown', () => {
    expect(isSubscribedMember({ status: 'left' })).toBe(false);
    expect(isSubscribedMember({ status: 'kicked' })).toBe(false);
    expect(isSubscribedMember({ status: 'whatever' })).toBe(false);
  });
});
