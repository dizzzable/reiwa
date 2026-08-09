/**
 * Property 21: Rate Limiting
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 *
 * For any IP address and rate-limited endpoint, requests exceeding the configured
 * threshold SHALL receive HTTP 429 with a Retry-After header containing a positive
 * integer. The system SHALL:
 * - Allow the 5th sign-in attempt to proceed then block subsequent attempts
 * - Allow 5 registrations per hour and block from the 6th
 * - Refund a registration attempt that created nothing, so the budget caps
 *   accounts rather than rejected form submissions
 * - Block password recovery for the window without banning the IP
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

  async eval(
    script: string,
    _numberOfKeys: number,
    key: string,
    windowSeconds?: number,
  ): Promise<[number, number] | number> {
    // Two scripts share this entry point now; dispatching on the body keeps the
    // double honest instead of counting a refund as another attempt.
    if (script.includes("DECR")) {
      // Mirrors REFUND_SCRIPT: absent key, a TTL larger than the one observed at
      // increment time (i.e. a window that started after ours), and a floored
      // counter all refuse the refund.
      const entry = this.store.get(key);
      if (!entry) return 0;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return 0;
      }
      const ttlAtIncrement = Number(windowSeconds ?? 0);
      if ((await this.ttl(key)) > ttlAtIncrement) return 0;
      const count = parseInt(entry.value, 10);
      if (count <= 0) return 0;
      entry.value = String(count - 1);
      return count - 1;
    }
    const count = await this.incr(key);
    if (count === 1) await this.expire(key, windowSeconds ?? 0);
    return [count, await this.ttl(key)];
  }

  /** Pretend `seconds` of the window have elapsed, so TTLs are comparable. */
  advance(seconds: number): void {
    for (const entry of this.store.values()) {
      if (entry.expiresAt !== null) entry.expiresAt -= seconds * 1000;
    }
  }

  /** Current attempt count, for asserting refunds. */
  async count(key: string): Promise<number> {
    const value = await this.get(key);
    return value === null ? 0 : parseInt(value, 10);
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

function createMockRequest(
  ip: string,
  accept?: string,
  method = 'POST',
  extra?: { headers?: Record<string, string>; originalUrl?: string },
): Request {
  const headers: Record<string, string> = { ...(accept ? { accept } : {}), ...(extra?.headers ?? {}) };
  return {
    ip,
    socket: { remoteAddress: ip },
    headers,
    method,
    originalUrl: extra?.originalUrl ?? '',
  } as unknown as Request;
}

function createMockResponse(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  // Declared here, not only on the cast below: the annotation is what callers
  // see, and `res.finish(...)` is how every test in this file completes a
  // request.
  finish: (statusCode: number) => void;
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
    redirect(status: number, location: string) {
      res.statusCode = status;
      res.headers['Location'] = location;
      return res;
    },
    finishListeners: [] as Array<() => void>,
    on(event: string, listener: () => void) {
      if (event === 'finish') res.finishListeners.push(listener);
      return res;
    },
    /** Express fires this once the response is flushed. */
    finish(statusCode: number) {
      res.statusCode = statusCode;
      for (const listener of res.finishListeners) listener();
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    finish: (statusCode: number) => void;
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

    it("allows exactly 5 requests during a concurrent burst", async () => {
      const ip = "203.0.113.10";
      const middleware = createRedisRateLimiter(redis as unknown as any, "login");

      const results = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const req = createMockRequest(ip);
          const res = createMockResponse();
          let passed = false;
          await middleware(req, res, () => {
            passed = true;
          });
          return { passed, statusCode: res.statusCode };
        }),
      );

      assert.equal(results.filter(({ passed }) => passed).length, 5);
      assert.equal(results.filter(({ statusCode }) => statusCode === 429).length, 45);
      assert.ok(await redis.ttl(RATE_LIMITS.login.keyBuilder(ip)) > 0);
    });
  });

  describe("Registration rate limit: 3 requests/hour, blocks from 3rd", () => {
    it("blocks starting from the 3rd registration request", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, async (ip) => {
          redis.clear();
          const results = await simulateRequests(redis, "register", ip, 7);

          // First 5 requests should pass (after_limit: the advertised number is
          // the number that actually gets through)
          for (let i = 0; i < 5; i++) {
            assert.equal(
              results[i].passed,
              true,
              `Registration request ${i + 1} should pass for IP ${ip}`,
            );
          }

          // 6th request and beyond should be blocked with 429
          for (let i = 5; i < results.length; i++) {
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

  describe("Recovery rate limit: 3 requests/hour, blocks without banning", () => {
    it("blocks from 3rd recovery request and leaves the IP unbanned", async () => {
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

          // Recovery must not lock the IP out of every other endpoint for a
          // day: forgetting which login you used is not abuse, and behind a
          // carrier NAT the ban lands on everyone sharing the address.
          const bannedData = await redis.get(`banned_ip:${ip}`);
          assert.equal(
            bannedData,
            null,
            `IP ${ip} must not be banned by the recovery limit`,
          );
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Registration budget counts accounts, not rejected submissions", () => {
    /** One registration attempt, flushed with the status the handler produced. */
    async function attempt(
      ip: string,
      finishStatus: number,
    ): Promise<{ passed: boolean; statusCode: number }> {
      const middleware = createRedisRateLimiter(
        redis as unknown as never,
        "register",
      );
      const req = createMockRequest(ip);
      const res = createMockResponse();
      let passed = false;
      await middleware(req, res, () => {
        passed = true;
      });
      if (passed) res.finish(finishStatus);
      return { passed, statusCode: res.statusCode };
    }

    it("refunds a malformed attempt, so five real signups still fit in the hour", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, async (ip) => {
          redis.clear();
          // Five rejected submissions: short password, bad characters, whatever.
          for (let i = 0; i < 5; i += 1) {
            const result = await attempt(ip, 400);
            assert.equal(result.passed, true, "a validation failure must reach the handler");
          }
          assert.equal(
            await redis.count(`rate:register:${ip}`),
            0,
            "attempts that created nothing must not hold the budget",
          );

          // The hour is still fully available for actual signups.
          for (let i = 0; i < 5; i += 1) {
            const result = await attempt(ip, 200);
            assert.equal(result.passed, true, `signup ${i + 1} should pass for IP ${ip}`);
          }
          const sixth = await attempt(ip, 200);
          assert.equal(sixth.statusCode, 429, "the 6th signup is still blocked");
        }),
        { numRuns: 50 },
      );
    });

    it("refunds a taken-username 409 — no account was created", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryIpv4, async (ip) => {
          redis.clear();
          // Picking a name that turns out to be taken is the most ordinary way
          // to fail a signup. `POST /auth/check-username` already answers the
          // same existence question outside this limiter, so charging for the
          // 409 protects nothing and costs everyone behind the IP a slot.
          for (let i = 0; i < 5; i += 1) {
            await attempt(ip, 409);
          }
          assert.equal(await redis.count(`rate:register:${ip}`), 0);
          const stillOpen = await attempt(ip, 200);
          assert.equal(stillOpen.passed, true);
        }),
        { numRuns: 50 },
      );
    });

    it("does NOT refund a 5xx, because the account may already exist", async () => {
      // `POST /auth/register` answers 500 "Account created but session setup
      // failed" after the upstream account was created. Refunding that would
      // hand the slot back for a real account and remove the cap entirely
      // during exactly the incident that produced the 500.
      const ip = "203.0.113.9";
      redis.clear();
      for (let i = 0; i < 5; i += 1) {
        const result = await attempt(ip, 500);
        assert.equal(result.passed, true);
      }
      assert.equal(await redis.count(`rate:register:${ip}`), 5);
      const blocked = await attempt(ip, 500);
      assert.equal(blocked.statusCode, 429, "five 5xx attempts still spend the hour");
    });

    it("a refund landing after the window rolled over does not credit the new window", async () => {
      const ip = "203.0.113.10";
      redis.clear();
      await attempt(ip, 200); // opens the window
      redis.advance(100); // 100s of it elapse
      // Admitted, but its response is still in flight when the hour ends.
      const middleware = createRedisRateLimiter(
        redis as unknown as never,
        "register",
      );
      const straggler = createMockResponse();
      let passed = false;
      await middleware(createMockRequest(ip), straggler, () => {
        passed = true;
      });
      assert.equal(passed, true);

      // The window ends and a fresh one fills up with real signups.
      redis.clear();
      for (let i = 0; i < 5; i += 1) await attempt(ip, 200);
      assert.equal(await redis.count(`rate:register:${ip}`), 5);

      straggler.finish(400); // …and only now does the straggler answer
      assert.equal(
        await redis.count(`rate:register:${ip}`),
        5,
        "a stale refund must not buy an extra signup in the next window",
      );
      const blocked = await attempt(ip, 200);
      assert.equal(blocked.statusCode, 429);
    });

    it("refunds an administratively blocked attempt without moving the window", async () => {
      const ip = "203.0.113.7";
      redis.clear();
      await attempt(ip, 200);
      const ttlAfterSignup = await redis.ttl(`rate:register:${ip}`);
      // 403 comes from the registration-mode gate, which runs after this
      // limiter — nothing was created, so the slot goes back.
      await attempt(ip, 403);
      assert.equal(
        await redis.count(`rate:register:${ip}`),
        1,
        "a request the mode gate refused must not spend a slot",
      );
      assert.equal(
        await redis.ttl(`rate:register:${ip}`),
        ttlAfterSignup,
        "refunding must leave the window ending when it would have",
      );
    });

    it("never drives the counter below zero", async () => {
      const ip = "203.0.113.8";
      redis.clear();
      for (let i = 0; i < 3; i += 1) await attempt(ip, 400);
      assert.equal(await redis.count(`rate:register:${ip}`), 0);
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

  it('redirects document navigations to the localized sign-in countdown instead of raw JSON', async () => {
    const middleware = createRedisRateLimiter(redis as unknown as any, 'login');
    for (let i = 0; i < RATE_LIMITS.login.maxAttempts; i += 1) {
      await middleware(createMockRequest('203.0.113.55'), createMockResponse(), () => undefined);
    }
    const response = createMockResponse();
    await middleware(
      createMockRequest('203.0.113.55', 'text/html,application/xhtml+xml', 'GET'),
      response,
      () => undefined,
    );
    assert.equal(response.statusCode, 303);
    assert.match(response.headers['Location'] ?? '', /^\/sign-in\?rate_limited=1&retry_after=\d+$/);
    assert.ok(response.headers['Retry-After']);
  });

  it('redirects a Telegram webview navigation (Sec-Fetch-Dest: document, no text/html Accept) instead of raw JSON', async () => {
    const middleware = createRedisRateLimiter(redis as unknown as any, 'login');
    for (let i = 0; i < RATE_LIMITS.login.maxAttempts; i += 1) {
      await middleware(createMockRequest('203.0.113.56'), createMockResponse(), () => undefined);
    }
    const response = createMockResponse();
    // Some in-app browsers send `Accept: */*` on top-level navigations; the fix
    // must still redirect them rather than fall through to the JSON branch.
    await middleware(
      createMockRequest('203.0.113.56', '*/*', 'GET', {
        headers: { 'sec-fetch-dest': 'document' },
      }),
      response,
      () => undefined,
    );
    assert.equal(response.statusCode, 303);
    assert.match(response.headers['Location'] ?? '', /^\/sign-in\?rate_limited=1&retry_after=\d+$/);
  });

  it('redirects an OAuth start/callback navigation by path even without navigation hints', async () => {
    const middleware = createRedisRateLimiter(redis as unknown as any, 'login');
    for (let i = 0; i < RATE_LIMITS.login.maxAttempts; i += 1) {
      await middleware(createMockRequest('203.0.113.57'), createMockResponse(), () => undefined);
    }
    const response = createMockResponse();
    await middleware(
      createMockRequest('203.0.113.57', '*/*', 'GET', {
        originalUrl: '/api/v1/auth/ext/google/callback?code=abc&state=xyz',
      }),
      response,
      () => undefined,
    );
    assert.equal(response.statusCode, 303);
    assert.match(response.headers['Location'] ?? '', /^\/sign-in\?rate_limited=1&retry_after=\d+$/);
  });

  it('keeps fetch/XHR 429s as structured JSON with retryAfter (no redirect)', async () => {
    const middleware = createRedisRateLimiter(redis as unknown as any, 'login');
    for (let i = 0; i < RATE_LIMITS.login.maxAttempts; i += 1) {
      await middleware(createMockRequest('203.0.113.58'), createMockResponse(), () => undefined);
    }
    const response = createMockResponse();
    // A POST XHR (e.g. the sign-in form) must not be redirected.
    await middleware(createMockRequest('203.0.113.58'), response, () => undefined);
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['Location'], undefined);
    const body = response.body as { message: string; retryAfter: number };
    assert.ok(body.retryAfter > 0, 'JSON 429 must carry retryAfter for the countdown');
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
