/**
 * Redis Key Schema and TTL Configuration
 *
 * Provides typed key builders and TTL constants for all Redis-backed
 * ephemeral state: sessions, linking codes, verification challenges,
 * rate limit counters, install banner suppression, IP blocks,
 * brute-force tracking, banned IPs, and recovery queue.
 */

// ── TTL Constants (in seconds) ──────────────────────────────────────────────

export const TTL = {
  /** Web session storage — 24 hours */
  SESSION: 24 * 60 * 60,
  /** Telegram linking code — 10 minutes */
  TELEGRAM_LINK: 10 * 60,
  /** Email verification challenge — 30 minutes */
  EMAIL_VERIFY: 30 * 60,
  /** Password recovery challenge — 15 minutes */
  RECOVERY: 15 * 60,
  /** Sign-in rate limit window — 15 minutes */
  RATE_LOGIN: 15 * 60,
  /** Registration rate limit window — 1 hour */
  RATE_REGISTER: 60 * 60,
  /** Recovery rate limit window — 1 hour */
  RATE_RECOVER: 60 * 60,
  /** Guest support creation rate limit window — 1 hour */
  RATE_GUEST_CREATE: 60 * 60,
  /** Guest support reply rate limit window — 1 minute */
  RATE_GUEST_REPLY: 60,
  /** Guest support attachment upload rate limit window — 1 minute */
  RATE_GUEST_UPLOAD: 60,
  /** Brute-force tracking window — 1 hour */
  BRUTE_FORCE: 60 * 60,
  /** Recovery queue (queued password generation) — 24 hours */
  RECOVERY_QUEUE: 24 * 60 * 60,
} as const;

// ── Key Builders ────────────────────────────────────────────────────────────

/**
 * Build a Redis key for web session storage.
 * Value: JSON `{userId, createdAt, ip, lastActivity}`
 */
export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Build a Redis key for a Telegram linking code.
 * Value: JSON `{userId, webAccountUuid}`
 */
export function telegramLinkKey(code: string): string {
  return `telegram_link:${code}`;
}

/**
 * Build a Redis key for an email verification challenge.
 * Value: JSON `{userId, code, attempts}`
 */
export function emailVerifyKey(challengeId: string): string {
  return `email_verify:${challengeId}`;
}

/**
 * Build a Redis key for a password recovery challenge.
 * Value: JSON `{userId, webAccountUuid}`
 */
export function recoveryKey(challengeId: string): string {
  return `recovery:${challengeId}`;
}

/**
 * Build a Redis key for the sign-in rate limit counter.
 * Value: Counter (integer)
 */
export function rateLoginKey(ip: string): string {
  return `rate:login:${ip}`;
}

/**
 * Build a Redis key for the registration rate limit counter.
 * Value: Counter (integer)
 */
export function rateRegisterKey(ip: string): string {
  return `rate:register:${ip}`;
}

/**
 * Build a Redis key for the recovery rate limit counter.
 * Value: Counter (integer)
 */
export function rateRecoverKey(ip: string): string {
  return `rate:recover:${ip}`;
}

/**
 * Build a Redis key for the anonymous guest-support creation rate limit.
 * Keyed by IP — bounds how many conversations one IP can open per window.
 * Value: Counter (integer)
 */
export function rateGuestCreateKey(ip: string): string {
  return `rate:guest_create:${ip}`;
}

/**
 * Build a Redis key for the anonymous guest-support reply rate limit.
 * Keyed by IP. Value: Counter (integer)
 */
export function rateGuestReplyKey(ip: string): string {
  return `rate:guest_reply:${ip}`;
}

/**
 * Build a Redis key for the anonymous guest-support attachment upload limit.
 * Keyed by IP — bounds heavier multipart/base64 uploads separately from text
 * replies. Value: Counter (integer)
 */
export function rateGuestUploadKey(ip: string): string {
  return `rate:guest_upload:${ip}`;
}

/**
 * Build a Redis key for install banner dismissal tracking.
 * Value: Timestamp (string, no TTL — persists indefinitely)
 */
export function installDismissedKey(fingerprint: string): string {
  return `install_dismissed:${fingerprint}`;
}

/**
 * Build a Redis key for permanent install banner suppression.
 * Value: Boolean string (no TTL — persists indefinitely)
 */
export function installPermanentDismissKey(userId: string): string {
  return `install_permanent_dismiss:${userId}`;
}

/**
 * Build a Redis key for IP-level blocks.
 * Value: Timestamp (no TTL — persists indefinitely)
 */
export function ipBlockKey(ip: string): string {
  return `ip_block:${ip}`;
}

/**
 * Build a Redis key for brute-force tracking per username.
 * Value: JSON `{ips[], attempts, lastAttempt}`
 */
export function bruteForceKey(username: string): string {
  return `brute_force:${username}`;
}

/**
 * Build a Redis key for permanently banned IPs.
 * Value: JSON `{reason, bannedAt, username}`
 */
export function bannedIpKey(ip: string): string {
  return `banned_ip:${ip}`;
}

/**
 * Build a Redis key for queued password generation.
 * Value: JSON `{userId, webAccountUuid, confirmedAt}`
 */
export function recoveryQueueKey(challengeId: string): string {
  return `recovery_queue:${challengeId}`;
}
