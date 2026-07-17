/**
 * Property 22: Coordinated Brute-Force Detection
 *
 * Validates: Requirements 11.4, 11.7
 *
 * For any account targeted by sign-in or recovery attempts from multiple
 * distinct IP addresses within a short time window, the system SHALL
 * automatically trigger coordinated attack detection, ban the offending IPs,
 * and flag the incident for admin review.
 *
 * Tests:
 * - <10 distinct IPs targeting the same username do NOT trigger detection
 * - 3+ distinct IPs targeting the same username DO trigger banning of all offending IPs
 * - Banned IPs receive 403 on subsequent requests
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createBruteForceDetection } from "../src/api/middleware/brute-force-detection.js";
import type { Request, Response, NextFunction } from "express";

// ── In-Memory Redis Mock ────────────────────────────────────────────────────

class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK"> {
    let expiresAt: number | undefined;
    // Handle "EX" ttl argument
    if (args[0] === "EX" && typeof args[1] === "number") {
      expiresAt = Date.now() + args[1] * 1000;
    }
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const self = this;
    return {
      set(key: string, value: string, ...args: unknown[]) {
        ops.push(() => self.set(key, value, ...args));
        return this;
      },
      async exec() {
        const results: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          try {
            const result = await op();
            results.push([null, result]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        return results;
      },
    };
  }

  clear(): void {
    this.store.clear();
  }

  /** Expose store for assertions */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

function createMockRequest(ip: string, username: string): Partial<Request> {
  return {
    ip,
    socket: { remoteAddress: ip } as any,
    body: { username },
  };
}

interface MockResponseResult {
  res: Partial<Response>;
  getStatusCode(): number | null;
  getJsonBody(): unknown;
}

function createMockResponse(): MockResponseResult {
  const state = { statusCode: null as number | null, jsonBody: null as unknown };

  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.jsonBody = body;
      return res;
    },
  } as unknown as Partial<Response>;

  return {
    res,
    getStatusCode() { return state.statusCode; },
    getJsonBody() { return state.jsonBody; },
  };
}

// ── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a valid username (lowercase alphanumeric + underscore/hyphen, 3-32 chars) */
const usernameArb = fc.string({ minLength: 3, maxLength: 32 })
  .map((s) => {
    // Map to valid username chars only
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789_-";
    return Array.from(s)
      .map((c) => chars[Math.abs(c.charCodeAt(0)) % chars.length])
      .join("")
      .slice(0, 32) || "abc";
  })
  .filter((s) => s.length >= 3 && s.length <= 32);

/** Generate a valid IPv4 address */
const ipv4Arb = fc.tuple(
  fc.integer({ min: 1, max: 254 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 1, max: 254 }),
).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** Generate a set of distinct IPs with a specific size */
function distinctIpsArb(minSize: number, maxSize: number) {
  return fc
    .uniqueArray(ipv4Arb, { minLength: minSize, maxLength: maxSize })
    .filter((arr) => arr.length >= minSize);
}

// ── Property Tests ──────────────────────────────────────────────────────────

describe("Property 22: Coordinated Brute-Force Detection", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  it("fewer than 10 distinct IPs targeting the same username do NOT trigger detection", async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        distinctIpsArb(1, 9),
        async (username, ips) => {
          redis.clear();

          const middleware = createBruteForceDetection(
            () => redis as any,
            (req: Request) => (req.body as any)?.username ?? null,
          );

          // Send requests from each IP targeting the same username
          for (const ip of ips) {
            const req = createMockRequest(ip, username) as Request;
            const mock = createMockResponse();
            let nextCalled = false;
            const next: NextFunction = () => { nextCalled = true; };

            await (middleware as any)(req, mock.res, next);

            // Should NOT be blocked — next() should be called
            assert.equal(nextCalled, true, `IP ${ip} should not be blocked with ${ips.length} distinct IPs`);
            assert.equal(mock.getStatusCode(), null, `Should not return any status code with ${ips.length} distinct IPs`);
          }

          // Verify no IPs are banned
          for (const ip of ips) {
            assert.equal(
              redis.has(`banned_ip:${ip}`),
              false,
              `IP ${ip} should NOT be banned with only ${ips.length} distinct IPs`,
            );
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("10 or more distinct IPs targeting the same username trigger banning of ALL offending IPs", async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        distinctIpsArb(10, 15),
        async (username, ips) => {
          redis.clear();

          const middleware = createBruteForceDetection(
            () => redis as any,
            (req: Request) => (req.body as any)?.username ?? null,
          );

          // Send only the first 10 IPs to trigger detection exactly at threshold
          const triggerIps = ips.slice(0, 10);
          let detectionTriggered = false;

          for (let i = 0; i < triggerIps.length; i++) {
            const ip = triggerIps[i];
            const req = createMockRequest(ip, username) as Request;
            const mock = createMockResponse();
            let nextCalled = false;
            const next: NextFunction = () => { nextCalled = true; };

            await (middleware as any)(req, mock.res, next);

            if (i === 9) {
              // The 10th distinct IP should trigger detection and get 403
              assert.equal(
                mock.getStatusCode(),
                403,
                `10th IP should receive 403 when coordinated attack is detected`,
              );
              detectionTriggered = true;
            } else {
              // First 2 IPs should pass through
              assert.equal(nextCalled, true, `IP at index ${i} should pass through`);
            }
          }

          // Detection must have been triggered
          assert.equal(
            detectionTriggered,
            true,
              `Coordinated attack detection should trigger with 10 distinct IPs`,
          );

          // All offending IPs that were tracked should be banned
          for (const ip of triggerIps) {
            assert.equal(
              redis.has(`banned_ip:${ip}`),
              true,
              `IP ${ip} should be banned after coordinated attack detection`,
            );
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("banned IPs receive 403 on subsequent requests", async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        distinctIpsArb(10, 10),
        usernameArb,
        async (username, ips, subsequentUsername) => {
          redis.clear();

          const middleware = createBruteForceDetection(
            () => redis as any,
            (req: Request) => (req.body as any)?.username ?? null,
          );

          // First: trigger the coordinated attack detection with exactly 10 IPs
          for (const ip of ips) {
            const req = createMockRequest(ip, username) as Request;
            const mock = createMockResponse();
            const next: NextFunction = () => {};
            await (middleware as any)(req, mock.res, next);
          }

          // Verify all 10 IPs are now banned
          for (const ip of ips) {
            assert.equal(
              redis.has(`banned_ip:${ip}`),
              true,
              `IP ${ip} should be banned before subsequent request test`,
            );
          }

          // Now: subsequent requests from banned IPs should get 403
          // regardless of the username they target
          for (const ip of ips) {
            const req = createMockRequest(ip, subsequentUsername) as Request;
            const mock = createMockResponse();
            let nextCalled = false;
            const next: NextFunction = () => { nextCalled = true; };

            await (middleware as any)(req, mock.res, next);

            assert.equal(
              mock.getStatusCode(),
              403,
              `Banned IP ${ip} should receive 403 on subsequent request`,
            );
            assert.equal(
              nextCalled,
              false,
              `Banned IP ${ip} should NOT have next() called`,
            );
            const body = mock.getJsonBody();
            assert.ok(
              body && typeof body === "object" && "message" in (body as object),
              `Response should include a message for banned IP ${ip}`,
            );
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
