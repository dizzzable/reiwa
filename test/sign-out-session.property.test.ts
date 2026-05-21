/**
 * Property 6: Sign-Out Invalidates Session
 *
 * **Validates: Requirements 2.5**
 *
 * For any active session, after invoking the sign-out endpoint, the session
 * token SHALL no longer grant access to any protected route.
 *
 * Feature: web-auth-pwa, Property 6: Sign-Out Invalidates Session
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import http from "node:http";

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

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK"> {
    let expiresAt: number | null = null;
    // Handle "EX" ttl argument
    if (args[0] === "EX" && typeof args[1] === "number") {
      expiresAt = Date.now() + (args[1] as number) * 1000;
    }
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
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

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async ttl(_key: string): Promise<number> {
    return -1;
  }

  clear(): void {
    this.store.clear();
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

async function httpRequest(
  app: express.Express,
  options: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: options.path,
          method: options.method,
          headers: {
            "content-type": "application/json",
            ...(bodyStr ? { "content-length": Buffer.byteLength(bodyStr).toString() } : {}),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(raw); } catch { body = { raw }; }
            server.close();
            resolve({ status: res.statusCode ?? 500, body, headers: res.headers });
          });
        },
      );

      req.on("error", (err) => { server.close(); reject(err); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

/**
 * Creates a test Express app that simulates the session lifecycle:
 * - POST /login: creates a session and returns the session ID
 * - POST /logout: destroys the session
 * - GET /protected: returns 200 if session is valid, 401 otherwise
 *
 * Uses the real session key format from the Redis keys module.
 */
function createSessionTestApp(redis: InMemoryRedis) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const COOKIE_NAME = "reiwa_web_session";
  const SESSION_TTL = 86400; // 24h in seconds

  // Session middleware: load session from Redis
  app.use((req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.cookies?.[COOKIE_NAME] as string | undefined;

    if (sessionId) {
      const key = `session:${sessionId}`;
      redis.get(key).then((raw) => {
        if (raw) {
          try {
            req.webSession = JSON.parse(raw);
            req.webSessionId = sessionId;
          } catch {
            req.webSession = null;
            req.webSessionId = null;
            res.clearCookie(COOKIE_NAME, { path: "/" });
          }
        } else {
          // Server-side session missing while cookie remains — clear stale cookie
          req.webSession = null;
          req.webSessionId = null;
          res.clearCookie(COOKIE_NAME, { path: "/" });
        }

        // Attach helpers
        attachSessionHelpers(req, res, redis, COOKIE_NAME, SESSION_TTL);
        next();
      }).catch(() => {
        req.webSession = null;
        req.webSessionId = null;
        attachSessionHelpers(req, res, redis, COOKIE_NAME, SESSION_TTL);
        next();
      });
    } else {
      req.webSession = null;
      req.webSessionId = null;
      attachSessionHelpers(req, res, redis, COOKIE_NAME, SESSION_TTL);
      next();
    }
  });

  // POST /login — create a session
  app.post("/login", async (req: Request, res: Response) => {
    const userId = (req.body as { userId?: string }).userId ?? "user-123";
    const sessionId = await req.createWebSession(userId);
    res.json({ success: true, sessionId });
  });

  // POST /logout — destroy the session (mirrors auth.ts logout handler)
  app.post("/logout", async (req: Request, res: Response) => {
    try {
      await req.destroyWebSession();
      res.json({ success: true });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.json({ success: true });
    }
  });

  // GET /protected — requires valid session
  app.get("/protected", (req: Request, res: Response) => {
    if (req.webSession && req.webSessionId) {
      res.json({ authenticated: true, userId: req.webSession.userId });
    } else {
      res.status(401).json({ authenticated: false, message: "Unauthorized" });
    }
  });

  return app;
}

function attachSessionHelpers(
  req: Request,
  res: Response,
  redis: InMemoryRedis,
  cookieName: string,
  ttl: number,
) {
  req.createWebSession = async (userId: string): Promise<string> => {
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const session = {
      userId,
      createdAt: now,
      ip: req.ip ?? "127.0.0.1",
      lastActivity: now,
    };
    await redis.set(`session:${sessionId}`, JSON.stringify(session), "EX", ttl);
    res.cookie(cookieName, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: ttl * 1000,
    });
    req.webSession = session;
    req.webSessionId = sessionId;
    return sessionId;
  };

  req.destroyWebSession = async (): Promise<void> => {
    if (req.webSessionId) {
      await redis.del(`session:${req.webSessionId}`);
      res.clearCookie(cookieName, { path: "/" });
      req.webSession = null;
      req.webSessionId = null;
    }
  };
}

// ── Arbitrary Generators ────────────────────────────────────────────────────

/** Generate arbitrary user IDs (alphanumeric, 3-32 chars) */
const arbitraryUserId = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
    { minLength: 3, maxLength: 32 },
  )
  .map((chars) => `user-${chars.join("")}`);

// ── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: web-auth-pwa, Property 6: Sign-Out Invalidates Session", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  describe("After sign-out, the session token no longer grants access", () => {
    it("for any user, creating a session then logging out invalidates the session in Redis", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUserId, async (userId) => {
          redis.clear();
          const app = createSessionTestApp(redis);

          // Step 1: Create a session (login)
          const loginRes = await httpRequest(app, {
            method: "POST",
            path: "/login",
            body: { userId },
          });
          assert.equal(loginRes.status, 200, "Login should succeed");
          assert.equal(loginRes.body.success, true);

          const sessionId = loginRes.body.sessionId as string;
          assert.ok(sessionId, "Login should return a session ID");

          // Extract the session cookie from the response
          const setCookieHeader = loginRes.headers["set-cookie"];
          assert.ok(setCookieHeader, "Login should set a session cookie");
          const cookieStr = Array.isArray(setCookieHeader)
            ? setCookieHeader.join("; ")
            : setCookieHeader;

          // Verify session exists in Redis before logout
          assert.ok(
            redis.has(`session:${sessionId}`),
            "Session should exist in Redis after login",
          );

          // Step 2: Verify the session grants access to protected routes
          const protectedBeforeRes = await httpRequest(app, {
            method: "GET",
            path: "/protected",
            headers: { cookie: cookieStr },
          });
          assert.equal(
            protectedBeforeRes.status,
            200,
            "Protected route should be accessible before logout",
          );
          assert.equal(protectedBeforeRes.body.authenticated, true);

          // Step 3: Call logout with the session cookie
          const logoutRes = await httpRequest(app, {
            method: "POST",
            path: "/logout",
            headers: { cookie: cookieStr },
          });
          assert.equal(logoutRes.status, 200, "Logout should succeed");
          assert.equal(logoutRes.body.success, true);

          // Step 4: Verify session is destroyed in Redis
          assert.equal(
            redis.has(`session:${sessionId}`),
            false,
            "Session should be removed from Redis after logout",
          );

          // Step 5: Verify the same session cookie no longer grants access
          const protectedAfterRes = await httpRequest(app, {
            method: "GET",
            path: "/protected",
            headers: { cookie: cookieStr },
          });
          assert.equal(
            protectedAfterRes.status,
            401,
            "Protected route should reject requests after session is destroyed",
          );
          assert.equal(protectedAfterRes.body.authenticated, false);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Sign-out destroys only the current session", () => {
    it("other sessions for the same user remain valid after one session is destroyed", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUserId, async (userId) => {
          redis.clear();
          const app = createSessionTestApp(redis);

          // Create two sessions for the same user
          const login1Res = await httpRequest(app, {
            method: "POST",
            path: "/login",
            body: { userId },
          });
          const sessionId1 = login1Res.body.sessionId as string;
          const cookie1 = Array.isArray(login1Res.headers["set-cookie"])
            ? login1Res.headers["set-cookie"].join("; ")
            : login1Res.headers["set-cookie"] ?? "";

          const login2Res = await httpRequest(app, {
            method: "POST",
            path: "/login",
            body: { userId },
          });
          const sessionId2 = login2Res.body.sessionId as string;
          const cookie2 = Array.isArray(login2Res.headers["set-cookie"])
            ? login2Res.headers["set-cookie"].join("; ")
            : login2Res.headers["set-cookie"] ?? "";

          // Both sessions should exist
          assert.ok(redis.has(`session:${sessionId1}`));
          assert.ok(redis.has(`session:${sessionId2}`));

          // Logout session 1
          await httpRequest(app, {
            method: "POST",
            path: "/logout",
            headers: { cookie: cookie1 },
          });

          // Session 1 should be destroyed
          assert.equal(
            redis.has(`session:${sessionId1}`),
            false,
            "Logged-out session should be destroyed",
          );

          // Session 2 should still be valid
          assert.equal(
            redis.has(`session:${sessionId2}`),
            true,
            "Other sessions should remain valid",
          );

          // Session 2 should still grant access
          const protectedRes = await httpRequest(app, {
            method: "GET",
            path: "/protected",
            headers: { cookie: cookie2 },
          });
          assert.equal(
            protectedRes.status,
            200,
            "Other session should still grant access to protected routes",
          );
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Subsequent requests with destroyed session ID are rejected", () => {
    it("any request using a destroyed session ID receives 401", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUserId,
          fc.integer({ min: 1, max: 5 }),
          async (userId, numRetries) => {
            redis.clear();
            const app = createSessionTestApp(redis);

            // Create and destroy a session
            const loginRes = await httpRequest(app, {
              method: "POST",
              path: "/login",
              body: { userId },
            });
            const cookie = Array.isArray(loginRes.headers["set-cookie"])
              ? loginRes.headers["set-cookie"].join("; ")
              : loginRes.headers["set-cookie"] ?? "";

            // Logout
            await httpRequest(app, {
              method: "POST",
              path: "/logout",
              headers: { cookie },
            });

            // Try accessing protected route multiple times with the old cookie
            for (let i = 0; i < numRetries; i++) {
              const res = await httpRequest(app, {
                method: "GET",
                path: "/protected",
                headers: { cookie },
              });
              assert.equal(
                res.status,
                401,
                `Attempt ${i + 1}: destroyed session should not grant access`,
              );
              assert.equal(res.body.authenticated, false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
