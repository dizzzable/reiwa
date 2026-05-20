/**
 * Unit tests for linking and push route handlers (task 6.10)
 *
 * Tests the following endpoints:
 * - POST /api/v1/link/telegram/initiate
 * - POST /api/v1/link/email/initiate
 * - POST /api/v1/link/email/verify
 * - POST /api/v1/push/subscribe
 * - DELETE /api/v1/push/unsubscribe
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import http from "node:http";

// ── Mock Dependencies ───────────────────────────────────────────────────────

function createMockAdminClient() {
  return {
    linkTelegramGenerate: mock.fn(async () => ({
      code: "AB12CD34",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })),
    linkEmailInitiate: mock.fn(async () => ({
      success: true,
      message: "Verification code sent to your email",
    })),
    linkEmailVerify: mock.fn(async () => ({
      success: true,
      verified: true,
    })),
    pushSubscribe: mock.fn(async () => ({
      success: true,
    })),
    pushUnsubscribe: mock.fn(async () => ({
      success: true,
    })),
    getBotConfig: mock.fn(async () => ({
      telegramBotUsername: "@rezeis_bot",
    })),
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
  authenticated?: boolean;
}) {
  const adminClient = overrides?.adminClient ?? createMockAdminClient();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.set("trust proxy", 1);

  // Attach web session helpers (mimicking the web session middleware)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (overrides?.authenticated !== false) {
      req.webSession = { userId: "user-123", createdAt: Date.now(), ip: "127.0.0.1", lastActivity: Date.now() };
      req.webSessionId = "session-123";
    } else {
      req.webSession = null;
      req.webSessionId = null;
    }
    req.context = "web";
    req.createWebSession = async () => "session-new";
    req.destroyWebSession = async () => {
      req.webSession = null;
      req.webSessionId = null;
    };
    next();
  });

  return { app, adminClient };
}

async function buildLinkingApp(overrides?: { adminClient?: ReturnType<typeof createMockAdminClient> | null; authenticated?: boolean }) {
  const { app, adminClient } = createTestApp(overrides);
  const { createLinkingRouter } = await import("../src/api/routes/linking.js");
  app.use("/api/v1", createLinkingRouter({
    adminClient: adminClient as any,
    webSessionStore: null,
    config: { NODE_ENV: "test" } as any,
  }));
  return { app, adminClient };
}

async function buildPushApp(overrides?: { adminClient?: ReturnType<typeof createMockAdminClient> | null; authenticated?: boolean }) {
  const { app, adminClient } = createTestApp(overrides);
  const { createPushRouter } = await import("../src/api/routes/push.js");
  app.use("/api/v1", createPushRouter({
    adminClient: adminClient as any,
    webSessionStore: null,
    config: { NODE_ENV: "test" } as any,
  }));
  return { app, adminClient };
}

// ── Linking Route Tests ─────────────────────────────────────────────────────

describe("POST /api/v1/link/telegram/initiate", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = await buildLinkingApp({ authenticated: false });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/telegram/initiate",
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Unauthorized");
  });

  it("returns linking code, expiry, and bot username on success", async () => {
    const { app } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/telegram/initiate",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, "AB12CD34");
    assert.ok(res.body.expiresAt);
    assert.equal(res.body.botUsername, "rezeis_bot");
  });

  it("returns 503 when admin client is unavailable", async () => {
    const { app } = await buildLinkingApp({ adminClient: null, authenticated: true });
    // Need to rebuild with null admin client
    const testApp = express();
    testApp.use(express.json());
    testApp.use(cookieParser());
    testApp.use((req: Request, _res: Response, next: NextFunction) => {
      req.webSession = { userId: "user-123", createdAt: Date.now(), ip: "127.0.0.1", lastActivity: Date.now() };
      req.webSessionId = "session-123";
      req.context = "web";
      req.createWebSession = async () => "session-new";
      req.destroyWebSession = async () => {};
      next();
    });
    const { createLinkingRouter } = await import("../src/api/routes/linking.js");
    testApp.use("/api/v1", createLinkingRouter({
      adminClient: null,
      webSessionStore: null,
      config: { NODE_ENV: "test" } as any,
    }));
    const res = await request(testApp, {
      method: "POST",
      path: "/api/v1/link/telegram/initiate",
    });
    assert.equal(res.status, 503);
  });
});

describe("POST /api/v1/link/email/initiate", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = await buildLinkingApp({ authenticated: false });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/initiate",
      body: { email: "test@example.com" },
    });
    assert.equal(res.status, 401);
  });

  it("validates email format", async () => {
    const { app } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/initiate",
      body: { email: "not-an-email" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Validation failed");
  });

  it("returns success on valid email", async () => {
    const { app, adminClient } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/initiate",
      body: { email: "test@example.com" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(adminClient.linkEmailInitiate.mock.callCount(), 1);
  });

  it("rejects empty email", async () => {
    const { app } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/initiate",
      body: { email: "" },
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /api/v1/link/email/verify", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = await buildLinkingApp({ authenticated: false });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/verify",
      body: { code: "123456" },
    });
    assert.equal(res.status, 401);
  });

  it("validates code format — must be 6 digits", async () => {
    const { app } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/verify",
      body: { code: "12345" },
    });
    assert.equal(res.status, 400);
  });

  it("rejects non-numeric codes", async () => {
    const { app } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/verify",
      body: { code: "abcdef" },
    });
    assert.equal(res.status, 400);
  });

  it("returns verified on valid code", async () => {
    const { app, adminClient } = await buildLinkingApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/verify",
      body: { code: "123456" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.verified, true);
    assert.equal(adminClient.linkEmailVerify.mock.callCount(), 1);
  });
});

// ── Push Route Tests ────────────────────────────────────────────────────────

describe("POST /api/v1/push/subscribe", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = await buildPushApp({ authenticated: false });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/subscribe",
      body: {
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
          keys: { p256dh: "key1", auth: "key2" },
        },
      },
    });
    assert.equal(res.status, 401);
  });

  it("validates subscription body", async () => {
    const { app } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/subscribe",
      body: { subscription: { endpoint: "not-a-url" } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Validation failed");
  });

  it("returns success on valid subscription", async () => {
    const { app, adminClient } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/subscribe",
      body: {
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
          keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs", auth: "tBHItJI5svbpC7htfNfQjA" },
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(adminClient.pushSubscribe.mock.callCount(), 1);
  });

  it("rejects subscription with missing keys", async () => {
    const { app } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/subscribe",
      body: {
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
          keys: { p256dh: "", auth: "" },
        },
      },
    });
    assert.equal(res.status, 400);
  });
});

describe("DELETE /api/v1/push/unsubscribe", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = await buildPushApp({ authenticated: false });
    const res = await request(app, {
      method: "DELETE",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 401);
  });

  it("validates endpoint is a valid URL", async () => {
    const { app } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "DELETE",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "not-a-url" },
    });
    assert.equal(res.status, 400);
  });

  it("returns success on valid unsubscribe", async () => {
    const { app, adminClient } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "DELETE",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(adminClient.pushUnsubscribe.mock.callCount(), 1);
  });

  it("retains subscription data when removal fails", async () => {
    const failingClient = createMockAdminClient();
    failingClient.pushUnsubscribe = mock.fn(async () => {
      throw new Error("AdminClient: DELETE /api/internal/push/unsubscribe → 500: Internal error");
    });

    const testApp = express();
    testApp.use(express.json());
    testApp.use(cookieParser());
    testApp.use((req: Request, _res: Response, next: NextFunction) => {
      req.webSession = { userId: "user-123", createdAt: Date.now(), ip: "127.0.0.1", lastActivity: Date.now() };
      req.webSessionId = "session-123";
      req.context = "web";
      req.createWebSession = async () => "session-new";
      req.destroyWebSession = async () => {};
      next();
    });
    const { createPushRouter } = await import("../src/api/routes/push.js");
    testApp.use("/api/v1", createPushRouter({
      adminClient: failingClient as any,
      webSessionStore: null,
      config: { NODE_ENV: "test" } as any,
    }));

    const res = await request(testApp, {
      method: "DELETE",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.retained, true);
  });

  it("treats 404 (already removed) as success", async () => {
    const notFoundClient = createMockAdminClient();
    notFoundClient.pushUnsubscribe = mock.fn(async () => {
      throw new Error("AdminClient: DELETE /api/internal/push/unsubscribe → 404: Not found");
    });

    const testApp = express();
    testApp.use(express.json());
    testApp.use(cookieParser());
    testApp.use((req: Request, _res: Response, next: NextFunction) => {
      req.webSession = { userId: "user-123", createdAt: Date.now(), ip: "127.0.0.1", lastActivity: Date.now() };
      req.webSessionId = "session-123";
      req.context = "web";
      req.createWebSession = async () => "session-new";
      req.destroyWebSession = async () => {};
      next();
    });
    const { createPushRouter } = await import("../src/api/routes/push.js");
    testApp.use("/api/v1", createPushRouter({
      adminClient: notFoundClient as any,
      webSessionStore: null,
      config: { NODE_ENV: "test" } as any,
    }));

    const res = await request(testApp, {
      method: "DELETE",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});
