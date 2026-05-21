/**
 * Property 21: Rate Limiting
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 *
 * For any IP address and rate-limited endpoint, requests exceeding the configured
 * threshold SHALL receive HTTP 429 with a Retry-After header containing a positive
 * integer. The system SHALL:
 * - Allow the 5th sign-in attempt to proceed then block subsequent attempts
 * - Block when the 3rd registration attempt is made (count reaches 3)
 * - Ban the IP address when password recovery rate limits are exceeded
 * - Continue to block on all subsequent attempts within the window
 *
 * When the rate limiting system is unavailable, the system SHALL return HTTP 503.
 *
 * Feature: web-auth-pwa, Property 21: Rate Limiting
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { Request, Response, NextFunction } from "express";
import {
  createRedisRateLimiter,
  RATE_LIMITS,
  type RateLimitEndpoint,
} from "../src/api/middleware/rate-limit.js";

// ── In-Memory Redis Mock ────────────────────────────────────────────────────

class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: null });
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || (entry.expiresAt !== null && Date.now() > entry.expiresAt)) {
      this.store.set(key, { value: "1", expiresAt: null });
      return 1;
    }
    const newVal = parseInt(entry.value, 10) + 1;
    entry.value = String(newVal);
    return newVal;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === null) return -1;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

function createMockRequest(ip: string): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function createMockResponse(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

async function simulateRequests(
  redis: InMemoryRedis,
  endpoint: RateLimitEndpoint,
  ip: string,
  count: number,
): Promise<Array<{ statusCode: number; headers: Record<string, string>; passed: boolean }>> {
  const middleware = createRedisRateLimiter(redis as unknown as any, endpoint);
  const results: Array<{ statusCode: number; headers: Record<string, string>; passed: boolean }> = [];

  for (let i = 0; i < count; i++) {
    const req = createMockRequest(ip);
    const res = createMockResponse();
    let passed = false;

    const next: NextFunction = () => {
      passed = true;
    };

    await middleware(req, res, next);
    results.push({
      statusCode: res.statusCode,
      headers: res.headers,
      passed,
    });
  }

  return results;
}

// ── Arbitrary Generators ────────────────────────────────────────────────────

const arbitraryIpv4 = fc.tuple(
  fc.integer({ min: 1, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 1, max: 254 }),
).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

// ── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: web-auth-pwa, Property 21: Rate Limiting", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  describe("Login rate limit: 5 requests/15min, blocks from 6th", () => {
    it("allows exactly 5 login requests then blocks the 6th and beyond", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, async (ip) => {
          redis.clear();
          const results = await simulateRequests(redis, "login", ip, 8);

          // First 5 requests should pass (after_limit behavior: block after maxAttempts)
          for (let i = 0; i < 5; i++) {
            assert.equal(
              results[i].passed,
              true,
              `Login request ${i + 1} should pass for IP ${ip}`,
            );
          }

          // 6th request and beyond should be blocked with 429
          for (let i = 5; i < results.length; i++) {
            assert.equal(
              results[i].statusCode,
              429,
              `Login request ${i + 1} should be blocked (429) for IP ${ip}`,
            );
            assert.ok(
              results[i].headers["Retry-After"],
              `Login request ${i + 1} should have Retry-After header`,
            );
            const retryAfter = parseInt(results[i].headers["Retry-After"], 10);
            assert.ok(
              retryAfter > 0,
              `Retry-After should be a positive integer, got ${retryAfter}`,
            );
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Registration rate limit: 3 requests/hour, blocks from 3rd", () => {
    it("blocks starting from the 3rd registration request", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, async (ip) => {
          redis.clear();
          const results = await simulateRequests(redis, "register", ip, 6);

          // First 2 requests should pass (at_limit behavior: block when count reaches maxAttempts)
          for (let i = 0; i < 2; i++) {
            assert.equal(
              results[i].passed,
              true,
              `Registration request ${i + 1} should pass for IP ${ip}`,
            );
          }

          // 3rd request and beyond should be blocked with 429
          for (let i = 2; i < results.length; i++) {
            assert.equal(
              results[i].statusCode,
              429,
              `Registration request ${i + 1} should be blocked (429) for IP ${ip}`,
            );
            assert.ok(
              results[i].headers["Retry-After"],
              `Registration request ${i + 1} should have Retry-After header`,
            );
            const retryAfter = parseInt(results[i].headers["Retry-After"], 10);
            assert.ok(
              retryAfter > 0,
              `Retry-After should be a positive integer, got ${retryAfter}`,
            );
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Recovery rate limit: 3 requests/hour, bans IP", () => {
    it("blocks from 3rd recovery request and bans the IP", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, async (ip) => {
          redis.clear();
          const results = await simulateRequests(redis, "recover", ip, 5);

          // First 2 requests should pass
          for (let i = 0; i < 2; i++) {
            assert.equal(
              results[i].passed,
              true,
              `Recovery request ${i + 1} should pass for IP ${ip}`,
            );
          }

          // 3rd request and beyond should be blocked with 429
          for (let i = 2; i < results.length; i++) {
            assert.equal(
              results[i].statusCode,
              429,
              `Recovery request ${i + 1} should be blocked (429) for IP ${ip}`,
            );
            assert.ok(
              results[i].headers["Retry-After"],
              `Recovery request ${i + 1} should have Retry-After header`,
            );
          }

          // Verify IP was banned in Redis
          const bannedData = await redis.get(`banned_ip:${ip}`);
          assert.ok(bannedData, `IP ${ip} should be banned after exceeding recovery limit`);
          const parsed = JSON.parse(bannedData);
          assert.ok(parsed.reason, "Ban record should include a reason");
          assert.ok(parsed.bannedAt, "Ban record should include a timestamp");
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("429 responses always include Retry-After header with positive integer", () => {
    it("all 429 responses have valid Retry-After header", async () => {
      const endpointArb = fc.constantFrom<RateLimitEndpoint>("login", "register", "recover");

      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, endpointArb, async (ip, endpoint) => {
          redis.clear();
          const config = RATE_LIMITS[endpoint];
          // Send enough requests to exceed the limit
          const requestCount = config.maxAttempts + 3;
          const results = await simulateRequests(redis, endpoint, ip, requestCount);

          // Check all 429 responses
          const blockedResults = results.filter((r) => r.statusCode === 429);
          assert.ok(
            blockedResults.length > 0,
            `Should have at least one 429 response for ${endpoint}`,
          );

          for (const result of blockedResults) {
            assert.ok(
              result.headers["Retry-After"],
              "429 response must include Retry-After header",
            );
            const retryAfter = parseInt(result.headers["Retry-After"], 10);
            assert.ok(
              Number.isInteger(retryAfter) && retryAfter > 0,
              `Retry-After must be a positive integer, got: ${result.headers["Retry-After"]}`,
            );
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Redis unavailability returns 503", () => {
    it("returns 503 when Redis is null (unavailable)", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryIpv4,
          fc.constantFrom<RateLimitEndpoint>("login", "register", "recover"),
          async (ip, endpoint) => {
            const middleware = createRedisRateLimiter(null, endpoint);
            const req = createMockRequest(ip);
            const res = createMockResponse();
            let passed = false;
            const next: NextFunction = () => { passed = true; };

            await middleware(req, res, next);

            assert.equal(passed, false, "Request should not pass when Redis is unavailable");
            assert.equal(res.statusCode, 503, "Should return 503 when Redis is unavailable");
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("HTTP 429 is strictly reserved for actual rate limit violations", () => {
    it("never returns 429 when requests are within limits", async () => {
      const endpointArb = fc.constantFrom<RateLimitEndpoint>("login", "register", "recover");

      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, endpointArb, async (ip, endpoint) => {
          redis.clear();
          const config = RATE_LIMITS[endpoint];
          // Send requests within the limit
          const safeCount =
            config.blockBehavior === "at_limit"
              ? config.maxAttempts - 1
              : config.maxAttempts;
          const results = await simulateRequests(redis, endpoint, ip, safeCount);

          for (let i = 0; i < results.length; i++) {
            assert.notEqual(
              results[i].statusCode,
              429,
              `Request ${i + 1} within limit should not get 429 for ${endpoint}`,
            );
            assert.equal(
              results[i].passed,
              true,
              `Request ${i + 1} within limit should pass for ${endpoint}`,
            );
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
