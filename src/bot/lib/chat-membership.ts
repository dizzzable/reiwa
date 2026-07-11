/**
 * Canonical Telegram chat-membership predicate.
 *
 * A quest reward is money, so membership must be proven strictly: only the
 * positive statuses count, and `restricted` counts ONLY while the user is still
 * a member (Telegram marks a left/kicked restricted user with
 * `is_member: false`). This is the single source of truth shared by the
 * fail-closed channel callback and the periodic recheck loop.
 */
export interface ChatMemberLike {
  readonly status: string;
  readonly is_member?: boolean;
}

export function isSubscribedMember(member: ChatMemberLike): boolean {
  if (
    member.status === 'member' ||
    member.status === 'administrator' ||
    member.status === 'creator'
  ) {
    return true;
  }
  if (member.status === 'restricted') {
    return member.is_member === true;
  }
  return false;
}
