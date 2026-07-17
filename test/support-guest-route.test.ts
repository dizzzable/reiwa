import { describe, it, expect, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import http from "node:http";

import { createSupportGuestRouter } from "../src/api/routes/support-guest.js";

/**
 * Public guest support router (Phase 2): anonymous access (no session, no
 * 401), httpOnly cookie issuance, authorization derived ONLY from the
 * cookie/resume token, dedicated rate limiting (429), captcha gating, and
 * content caps (413).
 */

/** Minimal in-memory ioredis stand-in covering the limiter's calls. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    incr: async (k: string) => {
      const n = parseInt(store.get(k) ?? "0", 10) + 1;
      store.set(k, String(n));
      return n;
    },
    eval: async (_script: string, _keyCount: number, k: string) => {
      const n = parseInt(store.get(k) ?? "0", 10) + 1;
      store.set(k, String(n));
      return [n, 60];
    },
    expire: async () => 1,
    ttl: async () => 60,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    },
  };
}

function makeApp(support: Record<string, unknown>, opts?: { turnstileSecret?: string }) {
  // Runtime config (enabled flag + Turnstile secret) is panel-managed and
  // fetched from rezeis; the router calls `support.getRuntimeConfig()`.
  const supportWithConfig = {
    getRuntimeConfig: async () => ({
      enabled: true,
      turnstileSiteKey: "",
      turnstileSecret: opts?.turnstileSecret ?? null,
    }),
    ...support,
  };
  const adminClient = { support: supportWithConfig } as never;
  const config = {
    REIWA_COOKIE_SECURE: false,
    NODE_ENV: "test",
    REIWA_ALLOW_INSECURE_COOKIES: true,
  } as never;
  const redis = fakeRedis();
  const webSessionStore = { getRedis: () => redis } as never;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1", createSupportGuestRouter({ adminClient, config, webSessionStore }));
  return app;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

async function request(
  app: express.Express,
  opts: { method: string; path: string; body?: unknown; cookie?: string },
): Promise<Res> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  try {
    return await new Promise<Res>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: opts.path,
          method: opts.method,
          headers: {
            "content-type": "application/json",
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
            ...(opts.cookie ? { cookie: opts.cookie } : {}),
          },
        },
        (resp) => {
          let data = "";
          resp.on("data", (c) => (data += c));
          resp.on("end", () =>
            resolve({
              status: resp.statusCode ?? 0,
              headers: resp.headers,
              body: data ? JSON.parse(data) : null,
            }),
          );
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  } finally {
    server.close();
  }
}

const okCreate = () =>
  vi.fn(async () => ({ token: "tok-xyz", resumeCode: "tok-xyz", ticket: { id: "t-1" } }));

describe("support-guest router", () => {
  it("opens a conversation anonymously (no 401) and sets an httpOnly cookie", async () => {
    const createGuest = okCreate();
    const app = makeApp({ createGuest });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/support/guest",
      body: { subject: "Help", message: "Payment stuck" },
    });
    expect(res.status).toBe(200);
    expect((res.body as { resumeCode: string }).resumeCode).toBe("tok-xyz");
    const setCookie = String(res.headers["set-cookie"]?.[0] ?? "");
    expect(setCookie).toMatch(/reiwa_support=tok-xyz/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(createGuest).toHaveBeenCalledTimes(1);
  });

  it("rejects creation without subject/message (400)", async () => {
    const app = makeApp({ createGuest: vi.fn() });
    const res = await request(app, { method: "POST", path: "/api/v1/support/guest", body: { subject: "x" } });
    expect(res.status).toBe(400);
  });

  it("rejects over-long content (413)", async () => {
    const app = makeApp({ createGuest: vi.fn() });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/support/guest",
      body: { subject: "x", message: "a".repeat(10_001) },
    });
    expect(res.status).toBe(413);
  });

  it("resolves GET ONLY by the cookie token, ignoring any client-supplied id", async () => {
    const getGuest = vi.fn(async (token: string) => ({ id: "t-1", token }));
    const app = makeApp({ getGuest });
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/support/guest?ticketId=someone-elses",
      cookie: "reiwa_support=tok-xyz",
    });
    expect(res.status).toBe(200);
    expect(getGuest).toHaveBeenCalledWith("tok-xyz");
  });

  it("returns 404 (not 401) when no token/cookie is present", async () => {
    const app = makeApp({ getGuest: vi.fn() });
    const res = await request(app, { method: "GET", path: "/api/v1/support/guest" });
    expect(res.status).toBe(404);
  });

  it("relays a reply using the cookie token", async () => {
    const replyGuest = vi.fn(async () => ({ id: "t-1" }));
    const app = makeApp({ replyGuest });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/support/guest/reply",
      cookie: "reiwa_support=tok-xyz",
      body: { content: "any update?" },
    });
    expect(res.status).toBe(200);
    expect(replyGuest).toHaveBeenCalledWith("tok-xyz", "any update?");
  });

  it("rate-limits creation per IP (429 on the 5th within the window)", async () => {
    const app = makeApp({ createGuest: okCreate() });
    const body = { subject: "Help", message: "again" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app, { method: "POST", path: "/api/v1/support/guest", body });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses[4]).toBe(429);
  });

  it("requires a valid captcha when Turnstile is configured", async () => {
    const createGuest = okCreate();
    const app = makeApp({ createGuest }, { turnstileSecret: "secret" });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/support/guest",
      body: { subject: "Help", message: "no captcha token" },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("captcha_failed");
    expect(createGuest).not.toHaveBeenCalled();
  });
});
