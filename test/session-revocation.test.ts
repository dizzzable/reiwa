/**
 * Signing a customer's other sessions out — the cabinet's half.
 *
 * A session is an opaque key in Redis with no index by customer, so the
 * cabinet cannot find a customer's sessions to end them. The panel keeps one
 * moment per account instead (`web_accounts.sessions_revoked_at`, in Postgres —
 * memory pressure on Redis cannot evict it), written by a password reset, a
 * password change, a first password and «Выйти на всех устройствах». Here:
 *
 *   - a session that started before the moment is ended at its next check, and
 *     one that started after it — or belongs to somebody else — is not;
 *   - each session asks at most once a minute (no panel round trip per
 *     request), so the staleness is bounded by that minute;
 *   - the browser that made the change carries on, on a NEW session that counts
 *     from the moment — even when the panel's clock runs ahead of this one;
 *   - the panel's moment and a session's start are compared on ONE clock: the
 *     panel answers with its `now`, and at ±30 s between the two servers a
 *     session opened just before a sign-out still ends and one opened just
 *     after it still stays — the Mini App's re-opened sessions included;
 *   - a panel that cannot answer signs nothing out: an older one — its own 404
 *     for a route it does not have, nothing else — is left alone for two
 *     minutes, a proxy's 404 or a port in an error's text silences nobody, one
 *     that fails is asked again next interval, and with no panel at all nothing
 *     is asked;
 *   - `/auth/first-password`, `/auth/password-state` and
 *     `/auth/sessions/revoke-others` act for the SESSION's customer only, and
 *     refuse without a session.
 *
 * Nothing between the routes and the panel is a double: the real session
 * middleware and store (over a Redis that is a `Map`, as in
 * `session-window.test.ts`), the real auth router, and the real `AdminClient`
 * calling a stand-in panel over HTTP. Requests to the cabinet go socketless
 * (`test/api/socketless-request.ts` says why).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import cookieParser from "cookie-parser";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  askSessionState,
  createSessionRevocationCheck,
  isRevocationCheckedPath,
  OLDER_PANEL_BACKOFF_MS,
  type SessionStateSource,
} from "../src/api/lib/session-revocation.js";
import { UpstreamError } from "../src/core/errors/index.js";
import { createAuthRouter } from "../src/api/routes/auth.js";
import { loadConfig } from "../src/core/config/index.js";
import { AdminClient } from "../src/infrastructure/admin-client/admin-client.js";
import { TTL } from "../src/infrastructure/redis/keys.js";
import {
  SESSION_REVOCATION_CHECK_INTERVAL_MS,
  WebSessionStore,
  createWebSessionMiddleware,
  type SessionRevocationCheck,
  type WebSession,
} from "../src/infrastructure/redis/session.js";
import { sendSocketless, type SocketlessResponse } from "./api/socketless-request.js";

const COOKIE = "reiwa_web_session";
const MINUTE = 60_000;
const HASH = "e".repeat(64);

// ── The store: the shipped class over a Redis that is a Map ────────────────

function liveStore() {
  const rows = new Map<string, string>();
  const redis = {
    async set(key: string, value: string): Promise<"OK"> {
      rows.set(key, value);
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      return rows.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return rows.delete(key) ? 1 : 0;
    },
  };
  const store = Object.create(WebSessionStore.prototype) as WebSessionStore;
  (store as unknown as { redis: unknown }).redis = redis;
  const read = (sessionId: string): WebSession | null => {
    const raw = rows.get(`session:${sessionId}`) ?? [...rows.entries()].find(([key]) => key.endsWith(sessionId))?.[1];
    return raw === undefined ? null : (JSON.parse(raw) as WebSession);
  };
  /** Rewrites a stored session — how a case sets the clock of a session it did not just open. */
  const patch = (sessionId: string, fields: Partial<WebSession>): void => {
    const key = [...rows.keys()].find((candidate) => candidate.endsWith(sessionId));
    if (key === undefined) throw new Error(`no session ${sessionId}`);
    rows.set(key, JSON.stringify({ ...JSON.parse(rows.get(key)!), ...fields }));
  };
  return { store, rows, read, patch };
}

// ── A stand-in panel, over a real socket ────────────────────────────────────

interface PanelCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

type PanelRoute = (body: Record<string, unknown>) => { status: number; body: unknown; delayMs?: number };

const servers: http.Server[] = [];
const clients: AdminClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

async function standInPanel(routes: Record<string, PanelRoute>) {
  const calls: PanelCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/api\/internal\/web-auth\//, "");
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const route = routes[path];
      const answer = route === undefined ? { status: 404, body: missingRoute(req.url ?? "") } : route(body);
      const send = () => {
        res.statusCode = answer.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(answer.body));
      };
      if (answer.delayMs === undefined) send();
      else setTimeout(send, answer.delayMs);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  servers.push(server);
  const client = new AdminClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "internal-token");
  clients.push(client);
  return { client, calls };
}

/**
 * What a panel older than a route answers for it: Nest's router refuses it, and
 * the panel's `AdminSafeExceptionFilter` writes the refusal — its message
 * scrubbed to "Request failed" because the path names `auth`
 * (`rezeis-admin/test/unknown-api-route-envelope.http.spec.ts` pins it there).
 */
function missingRoute(url: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    path: url.split("?")[0],
    requestId: null,
    statusCode: 404,
    message: "Request failed",
    errorCode: "NOT_FOUND",
    error: "Not Found",
  };
}

/**
 * A panel that keeps one sign-out moment per customer, as the real one does,
 * and answers with its own clock — `skewMs` ahead of this server's (behind,
 * when negative).
 */
function revocationRoutes(moments: Map<string, string>, skewMs = 0): Record<string, PanelRoute> {
  return {
    "sessions/state": (body) => ({
      status: 200,
      body: {
        sessionsRevokedAt: moments.get(String(body["userId"])) ?? null,
        now: new Date(Date.now() + skewMs).toISOString(),
      },
    }),
  };
}

// ── The cabinet ─────────────────────────────────────────────────────────────

function cabinet(
  store: WebSessionStore,
  revocation?: SessionRevocationCheck,
  adminClient: AdminClient | null = null,
  revocationCheckedPath?: (path: string) => boolean,
) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    createWebSessionMiddleware(
      store,
      { redisUrl: "", cookieSecure: false, isProduction: false },
      undefined,
      {
        ...(revocation === undefined ? {} : { revocation }),
        ...(revocationCheckedPath === undefined ? {} : { revocationCheckedPath }),
      },
    ),
  );
  const probe = (req: express.Request, res: express.Response) => {
    res.json({ signedIn: req.webSession !== null, userId: req.webSession?.userId ?? null });
  };
  // A page-shell / static-file path, and an API path.
  app.get("/probe", probe);
  app.get("/api/v1/probe", probe);
  app.use(
    "/api/v1",
    createAuthRouter({ adminClient, sessionStore: null, webSessionStore: store, config: loadConfig({ NODE_ENV: "test" }) }),
  );
  return app;
}

function call(app: express.Express, method: "GET" | "POST", url: string, sessionId: string | null, body?: unknown) {
  return sendSocketless(app, {
    method,
    url,
    headers: sessionId === null ? {} : { cookie: `${COOKIE}=${sessionId}` },
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * The session id a response leaves the browser holding, or `null` when it set
 * none or cleared it. The LAST line counts, as in a browser: the middleware
 * re-issues the incoming cookie first (the sliding window), and a renewal
 * replaces it after.
 */
function cookieSet(response: SocketlessResponse): string | null {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  const line = [...lines].reverse().find((candidate) => candidate.startsWith(`${COOKIE}=`));
  if (line === undefined) return null;
  const value = line.slice(COOKIE.length + 1).split(";")[0] ?? "";
  return value.length > 0 ? value : null;
}

async function openSession(store: WebSessionStore, userId: string, fields: Partial<WebSession> = {}) {
  const sessionId = await store.create({ userId }, "127.0.0.1");
  return { sessionId, fields };
}

describe("a session signed out elsewhere", () => {
  it("ends at its next check when it started before the panel's moment — and only then", async () => {
    const now = Date.now();
    const { store, patch, read } = liveStore();
    const moments = new Map([["user-a", new Date(now - 5 * MINUTE).toISOString()]]);
    const panel = await standInPanel(revocationRoutes(moments));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));

    const { sessionId: older } = await openSession(store, "user-a");
    patch(older, { createdAt: now - 10 * MINUTE, revocationCheckedAt: now - 2 * MINUTE });
    const { sessionId: newer } = await openSession(store, "user-a");
    patch(newer, { createdAt: now - 1 * MINUTE, revocationCheckedAt: now - 2 * MINUTE });
    const { sessionId: stranger } = await openSession(store, "user-b");
    patch(stranger, { createdAt: now - 10 * MINUTE, revocationCheckedAt: now - 2 * MINUTE });

    const gone = await call(app, "GET", "/probe", older);
    expect(gone.body).toEqual({ signedIn: false, userId: null });
    expect(read(older), "the ended session stayed in Redis").toBeNull();
    expect(String(gone.headers["set-cookie"] ?? "")).toMatch(new RegExp(`${COOKIE}=;`));

    expect((await call(app, "GET", "/probe", newer)).body).toEqual({ signedIn: true, userId: "user-a" });
    expect((await call(app, "GET", "/probe", stranger)).body).toEqual({ signedIn: true, userId: "user-b" });
  });

  it("asks at most once a minute per session, and records the question with the touch", async () => {
    const now = Date.now();
    const { store, patch, read } = liveStore();
    const panel = await standInPanel(revocationRoutes(new Map()));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { revocationCheckedAt: now - SESSION_REVOCATION_CHECK_INTERVAL_MS - 1 });

    for (let request = 0; request < 3; request += 1) {
      expect((await call(app, "GET", "/probe", sessionId)).body).toEqual({ signedIn: true, userId: "user-a" });
    }
    expect(panel.calls.filter((c) => c.path === "sessions/state")).toHaveLength(1);
    expect(read(sessionId)!.revocationCheckedAt).toBeGreaterThanOrEqual(now);

    patch(sessionId, { revocationCheckedAt: Date.now() - SESSION_REVOCATION_CHECK_INTERVAL_MS - 1 });
    await call(app, "GET", "/probe", sessionId);
    expect(panel.calls.filter((c) => c.path === "sessions/state")).toHaveLength(2);
  });

  it("asks at once for a session from before this release, which never asked", async () => {
    const now = Date.now();
    const { store, patch } = liveStore();
    const panel = await standInPanel(revocationRoutes(new Map([["user-a", new Date(now - MINUTE).toISOString()]])));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { createdAt: now - 3 * MINUTE, revocationCheckedAt: undefined });

    expect((await call(app, "GET", "/probe", sessionId)).body).toEqual({ signedIn: false, userId: null });
  });

  it("is asked about on an API request only — a static file never waits on the panel", async () => {
    const now = Date.now();
    const { store, patch } = liveStore();
    const panel = await standInPanel(revocationRoutes(new Map([["user-a", new Date(now - MINUTE).toISOString()]])));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), null, isRevocationCheckedPath);
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { createdAt: now - 3 * MINUTE, revocationCheckedAt: 0 });

    expect((await call(app, "GET", "/probe", sessionId)).body).toEqual({ signedIn: true, userId: "user-a" });
    expect(panel.calls, "a request outside the API asked the panel").toEqual([]);

    expect((await call(app, "GET", "/api/v1/probe", sessionId)).body).toEqual({ signedIn: false, userId: null });
    expect(panel.calls).toHaveLength(1);
  });

  it("does not hold a request for a panel slower than the deadline, and asks again next interval", async () => {
    const { store, patch, read } = liveStore();
    const panel = await standInPanel({
      "sessions/state": () => ({ status: 200, body: { sessionsRevokedAt: new Date().toISOString() }, delayMs: 400 }),
    });
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth, { deadlineMs: 50 }));
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { createdAt: 0, revocationCheckedAt: 0 });

    const started = Date.now();
    const answer = await call(app, "GET", "/probe", sessionId);

    expect(Date.now() - started, "the request waited for the slow panel").toBeLessThan(350);
    expect(answer.body).toEqual({ signedIn: true, userId: "user-a" });
    expect(read(sessionId)!.revocationCheckedAt).toBeGreaterThanOrEqual(started);
    await call(app, "GET", "/probe", sessionId);
    expect(panel.calls, "asked again within the interval").toHaveLength(1);
  });

  it("is not asked about for a whole interval after it was opened", async () => {
    const { store } = liveStore();
    const panel = await standInPanel(revocationRoutes(new Map()));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const { sessionId } = await openSession(store, "user-a");

    await call(app, "GET", "/probe", sessionId);

    expect(panel.calls).toEqual([]);
  });
});

describe("the browser that made the change", () => {
  it("carries on after a password change, on a new session that counts from the moment — the panel's clock ahead", async () => {
    // The panel's clock runs 30 s ahead of this server's. Compared by creation
    // time alone, the fresh session would start BEFORE the moment and be ended
    // by the very change its browser made.
    const now = Date.now();
    const { store, patch, read } = liveStore();
    const moments = new Map<string, string>();
    const aheadMoment = new Date(now + 30_000).toISOString();
    const panel = await standInPanel({
      ...revocationRoutes(moments),
      "change-password": (body) => {
        moments.set(String(body["userId"]), aheadMoment);
        return { status: 200, body: { success: true, sessionsRevokedAt: aheadMoment } };
      },
    });
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);
    const { sessionId: here } = await openSession(store, "user-a");
    patch(here, { standalone: true, platform: "ios" });
    const { sessionId: elsewhere } = await openSession(store, "user-a");

    const changed = await call(app, "POST", "/api/v1/auth/change-password", here, {
      currentPasswordHash: "a".repeat(64),
      newPasswordHash: HASH,
    });

    expect(changed.status).toBe(200);
    expect(panel.calls.find((c) => c.path === "change-password")?.body["userId"]).toBe("user-a");
    const renewed = cookieSet(changed);
    expect(renewed).not.toBeNull();
    expect(renewed).not.toBe(here);
    expect(read(here), "the old session id still works").toBeNull();
    const session = read(renewed!)!;
    expect(session.authFloor).toBe(Date.parse(aheadMoment));
    expect(session.standalone, "the installed-app flag was lost").toBe(true);
    expect(String(changed.headers["set-cookie"])).toContain(`Max-Age=${TTL.SESSION_PWA}`);

    // A minute on: this browser is asked about and stays; the other one ends.
    patch(renewed!, { revocationCheckedAt: 0 });
    patch(elsewhere, { revocationCheckedAt: 0 });
    expect((await call(app, "GET", "/probe", renewed)).body).toEqual({ signedIn: true, userId: "user-a" });
    expect((await call(app, "GET", "/probe", elsewhere)).body).toEqual({ signedIn: false, userId: null });
  });

  it("keeps its session as it was when the panel is older than the sign-out", async () => {
    const { store, read } = liveStore();
    const panel = await standInPanel({ "change-password": () => ({ status: 200, body: { success: true } }) });
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);
    const { sessionId } = await openSession(store, "user-a");

    const changed = await call(app, "POST", "/api/v1/auth/change-password", sessionId, {
      currentPasswordHash: "a".repeat(64),
      newPasswordHash: HASH,
    });

    expect(changed.status).toBe(200);
    expect(cookieSet(changed)).toBe(sessionId);
    expect(read(sessionId)?.authFloor).toBeUndefined();
  });
});

describe("one clock: the panel's moment against a session's start", () => {
  const SKEW = 30_000;

  it("panel 30 s AHEAD: a session opened just after a sign-out stays, one opened just before still ends", async () => {
    const now = Date.now();
    const signedOutAt = now - MINUTE; // real time of the sign-out
    const { store, patch } = liveStore();
    // The panel wrote the moment on ITS clock, 30 s ahead of this one.
    const moments = new Map([["user-a", new Date(signedOutAt + SKEW).toISOString()]]);
    const panel = await standInPanel(revocationRoutes(moments, SKEW));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));

    const { sessionId: after } = await openSession(store, "user-a");
    patch(after, { createdAt: signedOutAt + 5_000, revocationCheckedAt: 0 });
    const { sessionId: before } = await openSession(store, "user-a");
    patch(before, { createdAt: signedOutAt - 5_000, revocationCheckedAt: 0 });

    expect((await call(app, "GET", "/probe", after)).body, "a session opened AFTER the sign-out was ended by it").toEqual({
      signedIn: true,
      userId: "user-a",
    });
    expect((await call(app, "GET", "/probe", before)).body).toEqual({ signedIn: false, userId: null });
  });

  it("panel 30 s BEHIND: a session opened just before a sign-out still ends, one opened just after stays", async () => {
    const now = Date.now();
    const signedOutAt = now - MINUTE;
    const { store, patch } = liveStore();
    const moments = new Map([["user-a", new Date(signedOutAt - SKEW).toISOString()]]);
    const panel = await standInPanel(revocationRoutes(moments, -SKEW));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));

    const { sessionId: before } = await openSession(store, "user-a");
    patch(before, { createdAt: signedOutAt - 5_000, revocationCheckedAt: 0 });
    const { sessionId: after } = await openSession(store, "user-a");
    patch(after, { createdAt: signedOutAt + 5_000, revocationCheckedAt: 0 });

    expect((await call(app, "GET", "/probe", before)).body, "a session opened BEFORE the sign-out survived it").toEqual({
      signedIn: false,
      userId: null,
    });
    expect((await call(app, "GET", "/probe", after)).body).toEqual({ signedIn: true, userId: "user-a" });
  });

  it("does not end the Mini App's re-opened session again and again while the panel's moment is in this clock's future", async () => {
    // Signed out 10 s ago on a panel 30 s ahead: its moment reads 20 s in THIS
    // server's future. Compared on this clock, every session the Mini App opens
    // to get back in "started before" it — and is ended, and re-opened, for 20 s.
    const now = Date.now();
    const { store, patch } = liveStore();
    const moments = new Map([["user-a", new Date(now - 10_000 + SKEW).toISOString()]]);
    const panel = await standInPanel(revocationRoutes(moments, SKEW));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));

    for (let bootstrap = 0; bootstrap < 3; bootstrap += 1) {
      const { sessionId } = await openSession(store, "user-a");
      patch(sessionId, { revocationCheckedAt: 0 });
      expect((await call(app, "GET", "/probe", sessionId)).body, `re-opened session ${bootstrap + 1} was ended`).toEqual({
        signedIn: true,
        userId: "user-a",
      });
    }
  });

  it("keeps the browser that made the change on its floor whatever the clocks — and a LATER sign-out still ends it", async () => {
    const now = Date.now();
    const { store, patch } = liveStore();
    const moments = new Map<string, string>();
    const panel = await standInPanel(revocationRoutes(moments, SKEW));
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const changedAt = now + SKEW; // the panel's moment for this browser's own change
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { authFloor: changedAt, revocationCheckedAt: 0 });
    moments.set("user-a", new Date(changedAt).toISOString());

    expect((await call(app, "GET", "/probe", sessionId)).body, "its own change signed it out").toEqual({
      signedIn: true,
      userId: "user-a",
    });

    moments.set("user-a", new Date(changedAt + 2 * MINUTE).toISOString());
    patch(sessionId, { revocationCheckedAt: 0 });
    expect((await call(app, "GET", "/probe", sessionId)).body, "the floor outlived a later sign-out").toEqual({
      signedIn: false,
      userId: null,
    });
  });

  it("reads the two clocks' difference against the middle of the round trip", async () => {
    let clock = 1_000_000;
    const source: SessionStateSource = {
      sessionsState: async () => {
        clock += 400; // the round trip
        return { sessionsRevokedAt: null, now: new Date(1_000_200 + SKEW).toISOString() };
      },
    };

    const answer = await askSessionState(source, "user-a", { clock: () => clock });

    expect(answer).toEqual({ kind: "answered", state: { revokedAt: null, panelOffsetMs: SKEW } });
  });

  it("takes a panel that sends no clock to agree with this one", async () => {
    const source: SessionStateSource = { sessionsState: async () => ({ sessionsRevokedAt: "2026-09-18T10:00:00.000Z" }) };

    expect(await askSessionState(source, "user-a")).toEqual({
      kind: "answered",
      state: { revokedAt: Date.parse("2026-09-18T10:00:00.000Z"), panelOffsetMs: 0 },
    });
  });
});

describe("a panel that cannot tell signs nothing out", () => {
  it("backs off for two minutes, not ten", () => {
    expect(OLDER_PANEL_BACKOFF_MS).toBe(2 * MINUTE);
  });

  it("an older panel (its own 404 for a route it does not have): nobody signed out, and it is left alone for the back-off", async () => {
    const now = Date.now();
    const { store, patch } = liveStore();
    const panel = await standInPanel({});
    let clock = now;
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth, { clock: () => clock }));
    const sessions = [await openSession(store, "user-a"), await openSession(store, "user-b")];
    for (const { sessionId } of sessions) patch(sessionId, { createdAt: now - 60 * MINUTE, revocationCheckedAt: 0 });

    for (const { sessionId } of sessions) {
      const response = await call(app, "GET", "/probe", sessionId);
      expect(response.status).toBe(200);
      expect((response.body as { signedIn: boolean }).signedIn).toBe(true);
    }
    expect(panel.calls, "an older panel was asked once per session").toHaveLength(1);

    clock = now + OLDER_PANEL_BACKOFF_MS + 1;
    patch(sessions[0]!.sessionId, { revocationCheckedAt: 0 });
    await call(app, "GET", "/probe", sessions[0]!.sessionId);
    expect(panel.calls).toHaveLength(2);
  });

  it("a proxy's 404 while the panel restarts silences nobody — the next customer is still asked", async () => {
    const { store, patch } = liveStore();
    const panel = await standInPanel({
      "sessions/state": () => ({ status: 404, body: "<html><body><h1>404 Not Found</h1></body></html>" }),
    });
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const sessions = [await openSession(store, "user-a"), await openSession(store, "user-b")];
    for (const { sessionId } of sessions) patch(sessionId, { revocationCheckedAt: 0 });

    for (const { sessionId } of sessions) {
      expect(((await call(app, "GET", "/probe", sessionId)).body as { signedIn: boolean }).signedIn).toBe(true);
    }
    expect(panel.calls.filter((c) => c.path === "sessions/state"), "one proxy 404 silenced every customer").toHaveLength(2);
  });

  it("a route that exists answering 404 for something else is not the missing route either", async () => {
    const { store, patch } = liveStore();
    const panel = await standInPanel({
      "sessions/state": () => ({ status: 404, body: { statusCode: 404, message: "Web account not found", error: "Not Found" } }),
    });
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const sessions = [await openSession(store, "user-a"), await openSession(store, "user-b")];
    for (const { sessionId } of sessions) patch(sessionId, { revocationCheckedAt: 0 });

    for (const { sessionId } of sessions) await call(app, "GET", "/probe", sessionId);

    expect(panel.calls.filter((c) => c.path === "sessions/state")).toHaveLength(2);
  });

  it("the text \"4040\" in an error is a port, not a 404, and silences nobody", async () => {
    let asked = 0;
    const source: SessionStateSource = {
      sessionsState: async () => {
        asked += 1;
        throw new Error("connect ECONNREFUSED 10.0.0.5:4040");
      },
    };
    const check = createSessionRevocationCheck(source);

    expect(await check("user-a")).toBeNull();
    expect(await check("user-b")).toBeNull();
    expect(asked, "a port in the message read as a missing route").toBe(2);
  });

  it("a typed 404 whose body is not the panel's is not the missing route", async () => {
    let asked = 0;
    const source: SessionStateSource = {
      sessionsState: async () => {
        asked += 1;
        throw new UpstreamError("POST", "/api/internal/web-auth/sessions/state", 404, "Not Found");
      },
    };
    const check = createSessionRevocationCheck(source);

    await check("user-a");
    await check("user-b");
    expect(asked).toBe(2);
  });

  it("a panel that fails: nobody signed out, and asked again only at the next interval", async () => {
    const { store, patch } = liveStore();
    const panel = await standInPanel({ "sessions/state": () => ({ status: 500, body: { message: "boom" } }) });
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth));
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { revocationCheckedAt: 0 });

    expect((await call(app, "GET", "/probe", sessionId)).body).toEqual({ signedIn: true, userId: "user-a" });
    const asked = panel.calls.length;
    expect(asked).toBeGreaterThanOrEqual(1);
    await call(app, "GET", "/probe", sessionId);
    expect(panel.calls).toHaveLength(asked);
  });

  it("no panel at all: nothing is asked and nobody is signed out", async () => {
    const { store, patch } = liveStore();
    const app = cabinet(store);
    const { sessionId } = await openSession(store, "user-a");
    patch(sessionId, { createdAt: 0, revocationCheckedAt: 0 });

    expect((await call(app, "GET", "/probe", sessionId)).body).toEqual({ signedIn: true, userId: "user-a" });
  });
});

describe("the routes act for the session's customer, and only with a session", () => {
  function firstPasswordPanel(state: { hasPassword: boolean; login: string | null; exists: boolean }) {
    const moments = new Map<string, string>();
    return {
      moments,
      routes: {
        ...revocationRoutes(moments),
        "password/state": () =>
          state.exists
            ? { status: 200, body: { hasPassword: state.hasPassword, login: state.login } }
            : { status: 404, body: { statusCode: 404, message: "Web account not found" } },
        "password/first": (body: Record<string, unknown>) => {
          if (!state.exists || state.login === null) return { status: 200, body: { status: "no_account" } };
          if (state.hasPassword) return { status: 200, body: { status: "has_password" } };
          state.hasPassword = true;
          const at = new Date().toISOString();
          moments.set(String(body["userId"]), at);
          return { status: 200, body: { status: "set", login: state.login, sessionsRevokedAt: at } };
        },
        "sessions/revoke": (body: Record<string, unknown>) => {
          if (!state.exists) return { status: 404, body: { statusCode: 404, message: "Web account not found" } };
          const at = new Date().toISOString();
          moments.set(String(body["userId"]), at);
          return { status: 200, body: { sessionsRevokedAt: at } };
        },
      } satisfies Record<string, PanelRoute>,
    };
  }

  it("refuses all three without a session, and never asks the panel", async () => {
    const { store } = liveStore();
    const setup = firstPasswordPanel({ hasPassword: false, login: "imported_user", exists: true });
    const panel = await standInPanel(setup.routes);
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);

    for (const [method, url, body] of [
      ["POST", "/api/v1/auth/first-password", { newPasswordHash: HASH, userId: "user-a" }],
      ["GET", "/api/v1/auth/password-state", undefined],
      ["POST", "/api/v1/auth/sessions/revoke-others", { userId: "user-a" }],
    ] as const) {
      const response = await call(app, method, url, null, body);
      expect(response.status, url).toBe(401);
    }
    expect(panel.calls).toEqual([]);
  });

  it("sets a first password for the session's customer — never for a customer the body names", async () => {
    const { store, read } = liveStore();
    const setup = firstPasswordPanel({ hasPassword: false, login: "imported_user", exists: true });
    const panel = await standInPanel(setup.routes);
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);
    const { sessionId } = await openSession(store, "user-a");

    const state = await call(app, "GET", "/api/v1/auth/password-state", sessionId);
    expect(state.body).toEqual({ hasPassword: false });

    const set = await call(app, "POST", "/api/v1/auth/first-password", sessionId, {
      newPasswordHash: HASH,
      userId: "user-victim",
    });

    expect(set.status).toBe(200);
    expect(set.body).toEqual({ success: true, login: "imported_user" });
    const asked = panel.calls.filter((c) => c.path === "password/first");
    expect(asked).toEqual([{ path: "password/first", body: { userId: "user-a", newPassword: HASH } }]);
    const renewed = cookieSet(set);
    expect(renewed).not.toBe(sessionId);
    expect(read(renewed!)?.authFloor).toBe(Date.parse(setup.moments.get("user-a")!));

    const again = await call(app, "POST", "/api/v1/auth/first-password", renewed, { newPasswordHash: HASH });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ code: "PASSWORD_ALREADY_SET", message: "This account already has a password" });
  });

  it("says there is no usable account, and reads an older panel's silence as 'keep the ordinary form'", async () => {
    const { store } = liveStore();
    const setup = firstPasswordPanel({ hasPassword: false, login: null, exists: true });
    const panel = await standInPanel(setup.routes);
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);
    const { sessionId } = await openSession(store, "user-a");

    const set = await call(app, "POST", "/api/v1/auth/first-password", sessionId, { newPasswordHash: HASH });
    expect(set.status).toBe(409);
    expect((set.body as { code: string }).code).toBe("NO_WEB_ACCOUNT");

    const older = await standInPanel({});
    const olderApp = cabinet(store, createSessionRevocationCheck(older.client.webAuth), older.client);
    expect((await call(olderApp, "GET", "/api/v1/auth/password-state", sessionId)).body).toEqual({ hasPassword: null });
    const refused = await call(olderApp, "POST", "/api/v1/auth/first-password", sessionId, { newPasswordHash: HASH });
    expect(refused.status).toBe(503);
    expect((refused.body as { code: string }).code).toBe("FIRST_PASSWORD_UNAVAILABLE");
  });

  it("«Выйти на всех устройствах»: this browser stays, every other session of the customer ends", async () => {
    const { store, patch, read } = liveStore();
    const setup = firstPasswordPanel({ hasPassword: true, login: "alice", exists: true });
    const panel = await standInPanel(setup.routes);
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);
    const { sessionId: here } = await openSession(store, "user-a");
    const { sessionId: phone } = await openSession(store, "user-a");
    patch(phone, { createdAt: Date.now() - MINUTE });

    const revoked = await call(app, "POST", "/api/v1/auth/sessions/revoke-others", here, { userId: "user-victim" });

    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ success: true });
    expect(panel.calls.find((c) => c.path === "sessions/revoke")?.body).toEqual({ userId: "user-a" });
    const renewed = cookieSet(revoked)!;
    expect(read(here)).toBeNull();
    patch(renewed, { revocationCheckedAt: 0 });
    patch(phone, { revocationCheckedAt: 0 });
    expect((await call(app, "GET", "/probe", renewed)).body).toEqual({ signedIn: true, userId: "user-a" });
    expect((await call(app, "GET", "/probe", phone)).body).toEqual({ signedIn: false, userId: null });
  });

  it("«Выйти на всех устройствах» says it is unavailable when the panel cannot keep the moment", async () => {
    const { store, read } = liveStore();
    const setup = firstPasswordPanel({ hasPassword: false, login: null, exists: false });
    const panel = await standInPanel(setup.routes);
    const app = cabinet(store, createSessionRevocationCheck(panel.client.webAuth), panel.client);
    const { sessionId } = await openSession(store, "user-a");

    const refused = await call(app, "POST", "/api/v1/auth/sessions/revoke-others", sessionId);

    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe("SIGN_OUT_EVERYWHERE_UNAVAILABLE");
    expect(read(sessionId), "a refused sign-out ended this session").not.toBeNull();
  });
});
