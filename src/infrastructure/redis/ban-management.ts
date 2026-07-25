/**
 * Banned-IP management helpers.
 *
 * Central, TTL-correct entry point for reading, creating and clearing IP bans.
 * Bans are written with `TTL.BANNED_IP` so they self-expire (shared NAT / CGNAT
 * / mobile IPs rotate between real users — a permanent ban would lock out
 * innocent clients forever). `clearBannedIp` gives operators an explicit
 * early-unban path, which previously did not exist.
 */

import type { Redis } from "ioredis";

import { bannedIpKey, TTL } from "./keys.js";

export interface BannedIpRecord {
  readonly reason: string;
  readonly bannedAt: string;
  readonly username?: string;
}

/**
 * Returns the ban record for an IP, or `null` if it is not banned. A malformed
 * stored value is treated as "banned with unknown metadata" rather than
 * throwing, so a corrupt entry never accidentally unblocks an IP.
 */
export async function getBannedIp(
  redis: Redis,
  ip: string,
): Promise<BannedIpRecord | null> {
  const raw = await redis.get(bannedIpKey(ip));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BannedIpRecord;
  } catch {
    return { reason: "unknown", bannedAt: new Date(0).toISOString() };
  }
}

/** Convenience boolean check. */
export async function isIpBanned(redis: Redis, ip: string): Promise<boolean> {
  return (await redis.exists(bannedIpKey(ip))) === 1;
}

/**
 * Bans an IP with the standard self-expiring TTL. `ttlSeconds` may override the
 * default (e.g. a longer ban for a repeat offender) but always defaults to
 * `TTL.BANNED_IP` so callers can't accidentally create a permanent ban.
 */
export async function banIp(
  redis: Redis,
  ip: string,
  record: BannedIpRecord,
  ttlSeconds: number = TTL.BANNED_IP,
): Promise<void> {
  await redis.set(bannedIpKey(ip), JSON.stringify(record), "EX", ttlSeconds);
}

/**
 * Clears (unbans) an IP. Returns true if a ban existed and was removed. This is
 * the operator recourse for a false-positive ban on a shared/rotating address.
 */
export async function clearBannedIp(redis: Redis, ip: string): Promise<boolean> {
  return (await redis.del(bannedIpKey(ip))) > 0;
}
