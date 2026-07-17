/**
 * Coordinated Brute-Force Detection Middleware
 *
 * Detects multiple IPs targeting the same account (sign-in or recovery attempts
 * for a single username) within a short time window.
 *
 * Behavior:
 * - Tracks distinct IPs per username using Redis (`brute_force:{username}`)
 * - When 10+ distinct IPs target the same username within the tracking window (1h),
 *   immediately triggers coordinated attack detection
 * - Bans all offending IPs (`banned_ip:{ip}`) with reason, timestamp, and targeted username
 * - Flags the incident for admin review via logging
 * - Both IP banning and incident flagging must succeed together — if incident
 *   flagging fails, IPs are NOT banned
 *
 * Requirements: 11.7
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Redis } from "ioredis";
import { bruteForceKey, bannedIpKey, TTL } from "../../infrastructure/redis/keys.js";

import { getRequestLogger } from "./logger-accessor.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface BruteForceRecord {
  ips: string[];
  attempts: number;
  lastAttempt: number;
}

interface BannedIpRecord {
  reason: string;
  bannedAt: string;
  username: string;
}

interface CoordinatedAttackIncident {
  username: string;
  ips: string[];
  detectedAt: string;
  totalAttempts: number;
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Number of distinct IPs targeting the same username to trigger detection */
// Three addresses is common for mobile/home/work transitions and shared NATs.
// Ten distinct sources in one hour remains a strong distributed-attack signal.
const COORDINATED_ATTACK_THRESHOLD = 10;

// ── Incident Logger ─────────────────────────────────────────────────────────

/**
 * Flags the incident for admin review via the per-request structured
 * logger when available, falling back to console.warn otherwise.
 * Returns true if flagging succeeded.
 *
 * In a production system this could also write to a database, send an
 * alert, etc. — the structured log line is the minimum so SIEM / log
 * aggregators can pick it up.
 */
function flagIncidentForAdminReview(
  req: Request,
  incident: CoordinatedAttackIncident,
): boolean {
  try {
    const reqLogger = getRequestLogger(req);
    reqLogger.warn(
      { component: "SECURITY", incident },
      "Coordinated brute-force attack detected",
    );
    return true;
  } catch {
    return false;
  }
}

// ── Middleware Factory ───────────────────────────────────────────────────────

/**
 * Creates a middleware that:
 * 1. Checks if the requesting IP is already banned
 * 2. Records the attempt (IP + username) in Redis
 * 3. Detects coordinated attacks (10+ distinct IPs targeting same username)
 * 4. Bans all offending IPs and flags the incident
 *
 * @param getRedis - Function that returns the Redis client instance
 * @param extractUsername - Function to extract the target username from the request
 */
export function createBruteForceDetection(
  getRedis: () => Redis | null,
  extractUsername: (req: Request) => string | null,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const redis = getRedis();
    if (!redis) {
      // If Redis is unavailable, allow the request through
      // (rate limiting middleware handles the 503 case)
      next();
      return;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (ip === "unknown") {
      next();
      return;
    }

    // ── Step 1: Check if IP is already banned ─────────────────────────────
    try {
      const bannedRaw = await redis.get(bannedIpKey(ip));
      if (bannedRaw) {
        res.status(403).json({
          message: "Access denied",
          reason: "Your IP address has been banned due to suspicious activity",
        });
        return;
      }
    } catch {
      // If we can't check ban status, allow through (fail-open for reads)
      next();
      return;
    }

    // ── Step 2: Extract username from request ─────────────────────────────
    const username = extractUsername(req);
    if (!username) {
      // No username to track — skip brute-force detection
      next();
      return;
    }

    // ── Step 3: Record the attempt and check for coordinated attack ───────
    try {
      const key = bruteForceKey(username);
      const raw = await redis.get(key);

      let record: BruteForceRecord;
      if (raw) {
        record = JSON.parse(raw) as BruteForceRecord;
      } else {
        record = { ips: [], attempts: 0, lastAttempt: 0 };
      }

      // Add IP if not already tracked for this username
      if (!record.ips.includes(ip)) {
        record.ips.push(ip);
      }
      record.attempts += 1;
      record.lastAttempt = Date.now();

      // Persist updated record with TTL
      await redis.set(key, JSON.stringify(record), "EX", TTL.BRUTE_FORCE);

      // ── Step 4: Check threshold ───────────────────────────────────────
      if (record.ips.length >= COORDINATED_ATTACK_THRESHOLD) {
        // Coordinated attack detected — ban all offending IPs and flag incident
        const incident: CoordinatedAttackIncident = {
          username,
          ips: record.ips,
          detectedAt: new Date().toISOString(),
          totalAttempts: record.attempts,
        };

        // Flag incident first — if this fails, do NOT ban IPs
        const flagged = flagIncidentForAdminReview(req, incident);
        if (!flagged) {
          // Incident flagging failed — do not ban IPs, allow request through
          next();
          return;
        }

        // Ban all offending IPs
        const banRecord: BannedIpRecord = {
          reason: "Coordinated brute-force attack",
          bannedAt: new Date().toISOString(),
          username,
        };
        const banPayload = JSON.stringify(banRecord);

        const pipeline = redis.pipeline();
        for (const offendingIp of record.ips) {
          pipeline.set(bannedIpKey(offendingIp), banPayload);
        }
        await pipeline.exec();

        // Clear the brute-force tracking record (attack handled)
        await redis.del(key);

        // Reject the current request
        res.status(403).json({
          message: "Access denied",
          reason: "Your IP address has been banned due to suspicious activity",
        });
        return;
      }
    } catch (err) {
      // If tracking fails, allow the request through (fail-open)
      getRequestLogger(req).warn(
        { err, component: "BruteForceDetection" },
        "Error tracking attempt",
      );
    }

    next();
  };
}

/**
 * Convenience: creates brute-force detection middleware for auth endpoints
 * that expect a JSON body with a `username` field.
 */
export function createAuthBruteForceDetection(
  getRedis: () => Redis | null,
): RequestHandler {
  return createBruteForceDetection(getRedis, (req: Request) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body.username === "string" && body.username.trim()) {
      return body.username.trim().toLowerCase();
    }
    return null;
  });
}
