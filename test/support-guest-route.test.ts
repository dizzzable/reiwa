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

  it("keeps the device's key as long as the panel can keep the conversation open to it", async () => {
    // The panel decides the access: the TTL (72 h by default, up to 8760 h)
    // from the conversation's start, renewed from each operator reply. A key
    // that lived 72 h dropped the device out of a conversation an operator had
    // just answered — the reply the renewal exists for.
    const app = makeApp({ createGuest: okCreate() });
    const res = await request(app, {
      method: "POST",
      path: "/api/v1/support/guest",
      body: { subject: "Help", message: "Payment stuck" },
    });
    const maxAge = Number(/Max-Age=(\d+)/i.exec(String(res.headers["set-cookie"]?.[0] ?? ""))?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(8760 * 3600);
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

  it("resolves GET by the guest token, ignoring any client-supplied ticket id", async () => {
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

  it("opens the conversation from an emailed resume link and keeps it in the cookie", async () => {
    // The panel's guest-reply letter carries «Открыть переписку» to
    // `<cabinet>/support/guest?resume=<token>`; the page relays that token
    // here, on a device with no cookie yet.
    const getGuest = vi.fn(async (token: string) => ({ id: "t-1", token }));
    const app = makeApp({ getGuest });
    const res = await request(app, { method: "GET", path: "/api/v1/support/guest?resume=mail-tok" });
    expect(res.status).toBe(200);
    expect(getGuest).toHaveBeenCalledWith("mail-tok");
    expect(String(res.headers["set-cookie"] ?? "")).toContain("reiwa_support=mail-tok");
  });

  it("sets no cookie on an ordinary poll", async () => {
    // Only a way in writes the cookie. Re-issuing it on every poll would slide
    // its lifetime for ever and write a credential into every response.
    const getGuest = vi.fn(async () => ({ id: "t-1" }));
    const app = makeApp({ getGuest });
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/support/guest",
      cookie: "reiwa_support=tok-xyz",
    });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps the device's own conversation when a stray ?resume= arrives with its cookie", async () => {
    // A link does not take over a device through the poll: that is the
    // explicit, confirmed `POST /support/guest/resume` below.
    const getGuest = vi.fn(async (token: string) => ({ id: token === "mail-B" ? "t-B" : "t-A" }));
    const app = makeApp({ getGuest });
    const res = await request(app, {
      method: "GET",
      path: "/api/v1/support/guest?resume=mail-B",
      cookie: "reiwa_support=tok-A",
    });
    expect((res.body as { id: string }).id).toBe("t-A");
    expect(res.headers["set-cookie"]).toBeUndefined();
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

/**
 * Following a reply letter's «Открыть переписку»: `POST /support/guest/resume`.
 *
 * The panel issues a fresh link token with every operator reply and forgets the
 * previous one, so a link is a way IN, never the device's key. Kept as the
 * cookie, it dropped the visitor out of the conversation at the operator's very
 * next reply — the device that started the thread included, once it had
 * followed a link. The panel now answers a link with the conversation's durable
 * credential (`deviceToken`), and that is what the device keeps.
 *
 * And a link never takes over a device that already holds ANOTHER open
 * conversation without the visitor's say-so: a crafted link would otherwise
 * slip them into a thread its sender reads.
 */
describe("following a reply letter's link", () => {
  /**
   * One guest conversation as the panel serves it: the guest's own secret, the
   * current letter's token (rotated per reply), and the durable credential a
   * letter's token is exchanged for. A second, unrelated conversation `S-2`.
   */
  function guestPanel() {
    const state = { letter: "E1" };
    const thread = { id: "t-1", subject: "Оплата", status: "open" };
    const getGuest = vi.fn(async (token: string) => {
      if (token === "S-1" || token === "D-1") return { ...thread };
      if (token === state.letter) return { ...thread, deviceToken: "D-1" };
      if (token === "S-2") return { id: "t-2", subject: "Другое", status: "open" };
      throw new Error("rezeis responded 404");
    });
    const replyGuest = vi.fn(async (token: string) => ({ id: token === "S-2" ? "t-2" : "t-1" }));
    return { state, getGuest, replyGuest, app: makeApp({ getGuest, replyGuest }) };
  }

  const follow = (app: express.Express, resume: string, cookie?: string, confirm?: boolean) =>
    request(app, {
      method: "POST",
      path: "/api/v1/support/guest/resume",
      body: confirm === undefined ? { resume } : { resume, confirm },
      ...(cookie ? { cookie } : {}),
    });

  const cookieOf = (res: Res): string | null =>
    /reiwa_support=([^;]*)/.exec(String(res.headers["set-cookie"] ?? ""))?.[1] ?? null;

  it("keeps the conversation's credential, not the link, on a device with none", async () => {
    const { app, state } = guestPanel();

    const res = await follow(app, "E1");
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("opened");
    expect(cookieOf(res)).toBe("D-1");
    // The credential goes into the httpOnly cookie and nowhere else.
    expect(JSON.stringify(res.body)).not.toContain("D-1");

    state.letter = "E2"; // the operator replies again
    const poll = await request(app, { method: "GET", path: "/api/v1/support/guest", cookie: "reiwa_support=D-1" });
    expect(poll.status).toBe(200);
  });

  it("keeps the credential, not the link, when a page from before the resume route polls with it", async () => {
    // A tab loaded before this release still sends `?resume=` on its poll.
    const { app, state } = guestPanel();

    const res = await request(app, { method: "GET", path: "/api/v1/support/guest?resume=E1" });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toBe("D-1");
    expect(JSON.stringify(res.body)).not.toContain("D-1");

    state.letter = "E2";
    const poll = await request(app, { method: "GET", path: "/api/v1/support/guest", cookie: "reiwa_support=D-1" });
    expect(poll.status).toBe(200);
  });

  it("leaves the device that started the conversation on its own key", async () => {
    const { app, state } = guestPanel();

    const res = await follow(app, "E1", "reiwa_support=S-1");
    expect((res.body as { status: string }).status).toBe("continued");
    expect(res.headers["set-cookie"]).toBeUndefined();

    state.letter = "E2";
    const poll = await request(app, { method: "GET", path: "/api/v1/support/guest", cookie: "reiwa_support=S-1" });
    expect(poll.status).toBe(200);
  });

  it("says an old letter is out of date, and lets the device carry on", async () => {
    const { app, state } = guestPanel();
    state.letter = "E2"; // letter 2 already sent; the visitor opens letter 1

    const holding = await follow(app, "E1", "reiwa_support=S-1");
    expect(holding.body).toMatchObject({ status: "stale", ticket: { id: "t-1" } });
    expect(holding.headers["set-cookie"]).toBeUndefined();

    const empty = await follow(app, "E1");
    expect(empty.body).toMatchObject({ status: "stale", ticket: null });
  });

  it("asks before replacing another open conversation, and switches only when told to", async () => {
    const { app, replyGuest } = guestPanel();

    const asked = await follow(app, "E1", "reiwa_support=S-2");
    expect(asked.body).toEqual({
      status: "confirm",
      opening: { subject: "Оплата" },
      current: { subject: "Другое" },
    });
    expect(asked.headers["set-cookie"]).toBeUndefined();
    // Until then, what the visitor writes still goes to their own thread.
    await request(app, {
      method: "POST",
      path: "/api/v1/support/guest/reply",
      cookie: "reiwa_support=S-2",
      body: { content: "my login is …" },
    });
    expect(replyGuest).toHaveBeenLastCalledWith("S-2", "my login is …");

    const confirmed = await follow(app, "E1", "reiwa_support=S-2", true);
    expect((confirmed.body as { status: string }).status).toBe("opened");
    expect(cookieOf(confirmed)).toBe("D-1");
  });

  it("refuses a request without a token", async () => {
    const { app } = guestPanel();
    const res = await request(app, { method: "POST", path: "/api/v1/support/guest/resume", body: {} });
    expect(res.status).toBe(400);
  });
});
