/**
 * Unit tests for linking and push route handlers (task 6.10)
 *
 * Tests the following endpoints:
 * - POST /api/v1/link/telegram/initiate
 * - POST /api/v1/link/email/initiate
 * - POST /api/v1/link/email/verify
 * - POST /api/v1/push/subscribe
 * - POST /api/v1/push/unsubscribe
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import http from "node:http";
import { UpstreamError } from "../src/core/errors/index.js";

// ── Mock Dependencies ───────────────────────────────────────────────────────

/**
 * The admin client, in the NAMESPACED shape the routes actually call.
 *
 * It used to be flat — `linkTelegramGenerate`, `pushSubscribe` and so on —
 * which is the shape the client had before it was split into namespaces. The
 * routes moved; this fake did not, and nothing noticed, because this whole
 * file was collected by vitest and executed by nobody (it was written for
 * `node:test`). Every route here answered 500 on `Cannot read properties of
 * undefined` the moment it was finally run.
 */
function createMockAdminClient() {
  return {
    linking: {
      telegram: {
        generate: vi.fn(async () => ({
          code: "AB12CD34",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        })),
      },
      email: {
        initiate: vi.fn(async () => ({
          success: true,
          message: "Verification code sent to your email",
        })),
        verify: vi.fn(async () => ({
          success: true,
          verified: true,
        })),
      },
    },
    push: {
      getPublicKey: vi.fn(async () => ({ publicKey: "test-vapid-public-key" })),
      subscribe: vi.fn(async () => ({ success: true })),
      unsubscribe: vi.fn(async () => ({ success: true })),
    },
    branding: {
      getBotConfig: vi.fn(async () => ({
        telegramBotUsername: "@rezeis_bot",
      })),
    },
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
    assert.equal(adminClient.linking.email.initiate.mock.calls.length, 1);
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
    assert.equal(adminClient.linking.email.verify.mock.calls.length, 1);
  });
});

// ── What the panel refuses, said so the SPA can name it ─────────────────────

describe("the panel's refusals of an e-mail link reach the SPA as themselves, not as a 500", () => {
  async function initiateRefusedBy(status: number, body: string) {
    const adminClient = createMockAdminClient();
    adminClient.linking.email.initiate.mockRejectedValue(
      new UpstreamError("POST", "/api/internal/link/email/initiate", status, body),
    );
    const { app } = await buildLinkingApp({ adminClient, authenticated: true });
    return request(app, {
      method: "POST",
      path: "/api/v1/link/email/initiate",
      body: { email: "test@example.com" },
    });
  }

  it("answers 404 with a code when the panel does not know the account", async () => {
    // A panel older than the shell account answers exactly this for a customer
    // who came through the bot — the log line that started this.
    const res = await initiateRefusedBy(404, '{"message":"Web account not found for this userId"}');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "EMAIL_LINK_UNAVAILABLE");
  });

  it("answers 400 with a code when the panel rejects the address", async () => {
    for (const status of [400, 422]) {
      const res = await initiateRefusedBy(status, '{"message":["email must be an email"]}');
      assert.equal(res.status, 400, `panel ${status}`);
      assert.equal(res.body.code, "EMAIL_REJECTED", `panel ${status}`);
    }
  });

  it("answers 429 with a code when the panel is rate limiting", async () => {
    const res = await initiateRefusedBy(429, '{"message":"ThrottlerException: Too Many Requests"}');
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "EMAIL_RATE_LIMITED");
  });

  it("keeps answering 409 for an address another account holds, and 503 for an unavailable panel", async () => {
    assert.equal((await initiateRefusedBy(409, '{"message":"Email is already linked to another web account"}')).status, 409);
    assert.equal((await initiateRefusedBy(503, '{"message":"unavailable"}')).status, 503);
  });

  it("still answers 500 for a fault of ours (the panel refusing the cabinet's own credentials)", async () => {
    for (const status of [401, 403, 500]) {
      assert.equal((await initiateRefusedBy(status, "{}")).status, 500, `panel ${status}`);
    }
  });

  it("answers 409 when the address was taken between the code being sent and entered", async () => {
    const adminClient = createMockAdminClient();
    adminClient.linking.email.verify.mockRejectedValue(
      new UpstreamError("POST", "/api/internal/link/email/verify", 409, '{"message":"Email is already linked to another web account"}'),
    );
    const { app } = await buildLinkingApp({ adminClient, authenticated: true });

    const res = await request(app, {
      method: "POST",
      path: "/api/v1/link/email/verify",
      body: { code: "123456" },
    });

    assert.equal(res.status, 409);
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
          keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs", auth: "AAAAAAAAAAAAAAAAAAAAAA" },
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(adminClient.push.subscribe.mock.calls.length, 1);
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

// POST, not DELETE. The route and the cabinet client (`web/src/lib/api-client/
// push.ts`) both use POST; this block asked for DELETE and got 404 on every
// case, which nobody saw because the file never ran.
describe("POST /api/v1/push/unsubscribe", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = await buildPushApp({ authenticated: false });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 401);
  });

  it("validates endpoint is a valid URL", async () => {
    const { app } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "not-a-url" },
    });
    assert.equal(res.status, 400);
  });

  it("returns success on valid unsubscribe", async () => {
    const { app, adminClient } = await buildPushApp({ authenticated: true });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(adminClient.push.unsubscribe.mock.calls.length, 1);
  });

  it("retains subscription data when removal fails", async () => {
    const failingClient = createMockAdminClient();
    failingClient.push.unsubscribe = vi.fn(async () => {
      throw new Error("AdminClient: POST /api/internal/push/unsubscribe → 500: Internal error");
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
      method: "POST",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.retained, true);
  });

  it("treats 404 (already removed) as success", async () => {
    const notFoundClient = createMockAdminClient();
    notFoundClient.push.unsubscribe = vi.fn(async () => {
      throw new Error("AdminClient: POST /api/internal/push/unsubscribe → 404: Not found");
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
      method: "POST",
      path: "/api/v1/push/unsubscribe",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});
