/**
 * Unit tests for auth route handlers (task 6.8)
 *
 * Tests the following endpoints:
 * - POST /api/v1/auth/register
 * - POST /api/v1/auth/login
 * - POST /api/v1/auth/logout
 * - POST /api/v1/auth/recover
 * - GET /api/v1/auth/status
 * - POST /api/v1/auth/change-password
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import http from "node:http";

// ── Mock Dependencies ───────────────────────────────────────────────────────

/**
 * The admin client, in the NAMESPACED shape `src/api/routes/auth.ts` calls.
 *
 * It used to be flat — `webAuthRegister`, `getRegistrationToggle` and so on —
 * the shape the client had before it was split into namespaces. The routes
 * moved and this fake did not, and nothing noticed, because this whole file
 * was collected by vitest and executed by nobody (it was written for
 * `node:test`). Every route answered 500 the moment it was finally run.
 */
function createMockAdminClient() {
  return {
    webAuth: {
      register: vi.fn(async () => ({
        userId: "user-123",
        webAccountId: "wa-456",
      })),
      login: vi.fn(async () => ({
        userId: "user-123",
        requiresPasswordChange: false,
        telegramLinked: true,
        emailVerified: false,
      })),
      recover: vi.fn(async () => ({
        method: "telegram" as const,
        challengeId: "challenge-789",
      })),
      changePassword: vi.fn(async () => ({
        success: true,
      })),
    },
    system: {
      getRegistrationToggle: vi.fn(async () => ({
        enabled: true,
      })),
    },
  };
}

/**
 * Creates a mock Redis that always allows requests through rate limiting.
 * Returns a minimal ioredis-compatible interface.
 */
function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return "OK";
    }),
    incr: vi.fn(async (key: string) => {
      const current = parseInt(store.get(key) ?? "0", 10);
      const next = current + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
    // The rate limiter counts through a Lua script, so the fake has to answer
    // the way that script does: `[newCount, ttl]`, both integers. It OBEYS the
    // key and window it is handed rather than answering from its own state —
    // a middleware that counted under the wrong key would otherwise be
    // invisible here. Without this the limiter threw, every route answered
    // 503, and 23 of these tests failed on a defect that was in the fake.
    eval: vi.fn(
      async (_script: string, _numKeys: number, key: string, windowSeconds: number) => {
        const next = Number.parseInt(store.get(key) ?? '0', 10) + 1;
        store.set(key, String(next));
        return [next, windowSeconds];
      },
    ),
    ttl: vi.fn(async () => 900),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    pipeline: vi.fn(() => ({
      set: vi.fn(() => ({})),
      exec: vi.fn(async () => []),
    })),
  };
}

function createMockWebSessionStore(mockRedis?: ReturnType<typeof createMockRedis>) {
  const redis = mockRedis ?? createMockRedis();
  return {
    create: vi.fn(async (data: { userId: string }) => {
      return `session-${Date.now()}`;
    }),
    get: vi.fn(async () => null),
    destroy: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    getRedis: vi.fn(() => redis),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

// ── Test Helpers ────────────────────────────────────────────────────────────

async function request(
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

function createTestApp(overrides?: {
  adminClient?: ReturnType<typeof createMockAdminClient> | null;
  webSessionStore?: ReturnType<typeof createMockWebSessionStore> | null;
  authenticated?: boolean;
}) {
  const mockRedis = createMockRedis();
  const adminClient = overrides?.adminClient ?? createMockAdminClient();
  const webSessionStore = overrides?.webSessionStore ?? createMockWebSessionStore(mockRedis);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.set("trust proxy", 1);

  // Attach web session helpers (mimicking the web session middleware)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (overrides?.authenticated) {
      req.webSession = { userId: "user-123", createdAt: Date.now(), ip: "127.0.0.1", lastActivity: Date.now() };
      req.webSessionId = "session-123";
    } else {
      req.webSession = null;
      req.webSessionId = null;
    }
    req.context = "web";
    req.createWebSession = async (userId: string) => {
      return webSessionStore!.create({ userId });
    };
    req.destroyWebSession = async () => {
      req.webSession = null;
      req.webSessionId = null;
    };
    next();
  });

  return { app, adminClient, webSessionStore, mockRedis };
}

async function buildApp(overrides?: Parameters<typeof createTestApp>[0] & { noAdminClient?: boolean }) {
  const { app, adminClient, webSessionStore } = createTestApp(overrides);
  const { createAuthRouter } = await import("../src/api/routes/auth.js");
  app.use("/api/v1", createAuthRouter({
    adminClient: overrides?.noAdminClient ? null : adminClient as any,
    sessionStore: null,
    webSessionStore: webSessionStore as any,
    config: { NODE_ENV: "test" } as any,
  }));
  return { app, adminClient, webSessionStore };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/register", () => {
  it("validates request body — rejects missing fields", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/register",
      body: {},
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Validation failed");
  });

  it("validates username format — rejects invalid characters", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { username: "user@name!", passwordHash: "a".repeat(64) },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Validation failed");
  });

  it("validates username length — rejects too short", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { username: "ab", passwordHash: "a".repeat(64) },
    });
    assert.equal(res.status, 400);
  });

  it("validates passwordHash — rejects non-hex", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { username: "validuser", passwordHash: "g".repeat(64) },
    });
    assert.equal(res.status, 400);
  });

  it("succeeds with valid input and creates session", async () => {
    const { app, adminClient } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { username: "validuser", passwordHash: "a1b2c3d4".repeat(8) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.redirectUrl, "/dashboard");
    assert.equal(adminClient.webAuth.register.mock.calls.length, 1);
  });

  it("returns 503 when adminClient is null", async () => {
    const { app } = await buildApp({ noAdminClient: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { username: "validuser", passwordHash: "a1b2c3d4".repeat(8) },
    });
    assert.equal(res.status, 503);
  });
});

describe("POST /api/v1/auth/login", () => {
  it("validates request body — rejects empty username", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/login",
      body: { username: "", passwordHash: "abc123" },
    });
    assert.equal(res.status, 400);
  });

  it("returns generic error on invalid credentials", async () => {
    const adminClient = createMockAdminClient();
    adminClient.webAuth.login = vi.fn(async () => {
      throw new Error("AdminClient: POST /api/internal/web-auth/login → 401: Invalid credentials");
    });
    const { app } = await buildApp({ adminClient });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/login",
      body: { username: "testuser", passwordHash: "a1b2c3d4".repeat(8) },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Invalid username or password");
  });

  it("succeeds and returns redirect to dashboard", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/login",
      body: { username: "testuser", passwordHash: "a1b2c3d4".repeat(8) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.redirectUrl, "/dashboard");
    assert.equal(res.body.requiresPasswordChange, false);
  });

  it("redirects to change-password when requiresPasswordChange is true", async () => {
    const adminClient = createMockAdminClient();
    adminClient.webAuth.login = vi.fn(async () => ({
      userId: "user-123",
      requiresPasswordChange: true,
      telegramLinked: false,
      emailVerified: false,
    }));
    const { app } = await buildApp({ adminClient });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/login",
      body: { username: "testuser", passwordHash: "a1b2c3d4".repeat(8) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.redirectUrl, "/change-password");
    assert.equal(res.body.requiresPasswordChange, true);
    // Suppression flags are activated during successful authentication
    assert.equal(res.body.suppressErrors, true);
    assert.equal(res.body.suppressPasswordChangeRedirect, true);
  });

  it("returns generic error when adminClient is null", async () => {
    const { app } = await buildApp({ noAdminClient: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/login",
      body: { username: "testuser", passwordHash: "a1b2c3d4".repeat(8) },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Invalid username or password");
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("destroys session and returns success", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/logout",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

describe("POST /api/v1/auth/recover", () => {
  it("validates request body — rejects empty username", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/recover",
      body: { username: "" },
    });
    assert.equal(res.status, 400);
  });

  it("returns recovery method on success", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/recover",
      body: { username: "testuser" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.method, "telegram");
    assert.ok(typeof res.body.message === "string");
  });

  it("returns 503 when adminClient is null", async () => {
    const { app } = await buildApp({ noAdminClient: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/recover",
      body: { username: "testuser" },
    });
    assert.equal(res.status, 503);
  });
});

describe("GET /api/v1/auth/status", () => {
  it("returns unauthenticated status when no session", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/auth/status",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.isAuthenticated, false);
    assert.equal(res.body.isRegistrationEnabled, true);
    assert.equal(res.body.context, "web");
  });

  it("returns authenticated status when session exists", async () => {
    const { app } = await buildApp({ authenticated: true });
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/auth/status",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.isAuthenticated, true);
  });

  it("returns registration disabled when toggle is off", async () => {
    const adminClient = createMockAdminClient();
    adminClient.system.getRegistrationToggle = vi.fn(async () => ({ enabled: false }));
    const { app } = await buildApp({ adminClient });
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/auth/status",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.isRegistrationEnabled, false);
  });

  it("defaults registration to disabled when adminClient is null", async () => {
    const { app } = await buildApp({ noAdminClient: true });
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/auth/status",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.isRegistrationEnabled, false);
  });
});

describe("POST /api/v1/auth/change-password", () => {
  it("rejects unauthenticated requests", async () => {
    const { app } = await buildApp();
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/change-password",
      body: {
        currentPasswordHash: "a".repeat(64),
        newPasswordHash: "b".repeat(64),
      },
    });
    assert.equal(res.status, 401);
  });

  it("validates request body — rejects invalid hash format", async () => {
    const { app } = await buildApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/change-password",
      body: {
        currentPasswordHash: "too-short",
        newPasswordHash: "also-short",
      },
    });
    assert.equal(res.status, 400);
  });

  it("succeeds with valid input when authenticated", async () => {
    const { app, adminClient } = await buildApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/auth/change-password",
      body: {
        currentPasswordHash: "a".repeat(64),
        newPasswordHash: "b".repeat(64),
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.redirectUrl, "/dashboard");
    assert.equal(adminClient.webAuth.changePassword.mock.calls.length, 1);
  });
});
