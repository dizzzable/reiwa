/**
 * Channel-subscription gate helpers — shared by the `/start` page and the
 * `check_channel` / `menu:main` callbacks.
 *
 * The gate is configured on rezeis-admin (platform policy) and consumed by the
 * reiwa bot. A channel can be referenced three ways; this module resolves them
 * into a Telegram chat reference usable with `getChatMember`, derives a join
 * URL, classifies membership status, and tracks "already passed" users for the
 * relaxed (non-re-check) mode.
 */

import { sweepExpired } from './bounded-map.js';

export interface ChannelGatePolicy {
  readonly channelRequired?: boolean;
  readonly channelLink?: string | null;
  readonly channelId?: string | number;
  readonly channelUsername?: string | null;
  readonly channelRecheck?: boolean;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normaliseUsername(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

/**
 * Resolves a chat reference for `getChatMember`. Prefers the numeric
 * `channelId` (most robust), then `@username` (from `channelUsername` or a
 * `t.me/<name>` / `@name` link). Returns `null` when nothing usable is set
 * (e.g. only a private invite link, which `getChatMember` cannot resolve).
 */
export function resolveChannelChatId(policy: ChannelGatePolicy): string | number | null {
  if (policy.channelId !== undefined && String(policy.channelId).trim().length > 0) {
    return policy.channelId;
  }
  if (nonEmpty(policy.channelUsername)) {
    return normaliseUsername(policy.channelUsername);
  }
  if (nonEmpty(policy.channelLink)) {
    const link = policy.channelLink.trim();
    if (link.startsWith('@')) return link;
    const match = link.match(/t\.me\/([A-Za-z0-9_]+)/);
    if (match) return `@${match[1]}`;
  }
  return null;
}

/** Public URL that opens the channel for the "join" button. */
export function resolveChannelJoinUrl(policy: ChannelGatePolicy): string | null {
  if (nonEmpty(policy.channelLink)) {
    const link = policy.channelLink.trim();
    return link.startsWith('@') ? `https://t.me/${link.slice(1)}` : link;
  }
  if (nonEmpty(policy.channelUsername)) {
    const username = policy.channelUsername.trim().replace(/^@/, '');
    return `https://t.me/${username}`;
  }
  return null;
}

/** Membership statuses that count as "subscribed". */
export function isSubscribedStatus(status: string): boolean {
  return (
    status === 'member' ||
    status === 'administrator' ||
    status === 'creator' ||
    status === 'restricted'
  );
}

/** Whether the gate should run at all for the given policy. */
export function isChannelGateActive(policy: ChannelGatePolicy): boolean {
  return policy.channelRequired === true && resolveChannelChatId(policy) !== null;
}

// ── Relaxed (non-re-check) mode: remember users who already passed ───────────
const PASS_TTL_MS = 24 * 60 * 60 * 1000;
const passedAt = new Map<number, number>();

/**
 * When the map is swept. Below this it is left alone, so the ordinary path is
 * one `Map.set`; a bot with more than this many gate passes live at once is
 * large enough that one O(size) walk per write is not worth noticing.
 */
const PASS_SWEEP_THRESHOLD = 5_000;

export function markChannelPassed(userId: number): void {
  passedAt.set(userId, Date.now());
  // Entries used to expire only when the SAME user was read again, so anybody
  // who passed the gate once and never came back left a row for the lifetime of
  // the process. The map grew with everyone who had ever touched the bot rather
  // than with who was using it — invisible because a deploy resets it.
  sweepExpired(passedAt, PASS_SWEEP_THRESHOLD, (ts) => Date.now() - ts > PASS_TTL_MS);
}

export function hasRecentlyPassedChannel(userId: number): boolean {
  const ts = passedAt.get(userId);
  if (ts === undefined) return false;
  if (Date.now() - ts > PASS_TTL_MS) {
    passedAt.delete(userId);
    return false;
  }
  return true;
}

/** Test hook — clears the passed-gate memory. */
export function resetChannelGateMemory(): void {
  passedAt.clear();
}
