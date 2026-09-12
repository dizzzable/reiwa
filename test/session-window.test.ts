/**
 * How long a signed-in browser stays signed in.
 *
 * ── Why this file does not pin the number ───────────────────────────────────
 *
 * `expect(TTL.SESSION).toBe(2592000)` would guard nothing: it restates the
 * constant it reads, and it goes green for any future value the moment
 * somebody edits both lines together. The two things that were actually wrong
 * are relations, and relations are what is asserted here.
 *
 *  1. The BROWSER window was shorter than the INSTALLED-APP window — 24 hours
 *     against 30 days. That asymmetry was the whole of the owner's report
 *     that the cabinet "signs me out in the browser but not in the app", and
 *     it is also why the push repair looked like a PWA-versus-browser
 *     problem: a service worker re-registering a subscription posts with the
 *     session cookie, and a tab whose cookie had aged out got a 401 and never
 *     persisted the new endpoint.
 *
 *  2. The COOKIE is the binding half, not the Redis key. Both start within
 *     milliseconds of each other, but the browser stops SENDING the cookie
 *     first, and a live record nobody presents is not a session. So raising
 *     the Redis TTL while leaving the cookie at a day would look fixed,
 *     measure fixed in Redis, and still sign people out — which is exactly
 *     the kind of half-repair this file exists to catch.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cookieParser from "cookie-parser";
import express from "express";
import { describe, expect, it } from "vitest";

import { TTL } from "../src/infrastructure/redis/keys.js";
import {
  WebSessionStore,
  createWebSessionMiddleware,
} from "../src/infrastructure/redis/session.js";

const SESSION_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "infrastructure", "redis", "session.ts"),
  "utf8",
);

const DAY_SECONDS = 24 * 60 * 60;

const COOKIE_NAME = "reiwa_web_session";

/**
 * The real store and the real middleware, over a Redis that is a `Map`.
 *
 * Not a hand-written double of either: the point of the two cases at the foot
 * of this file is that the shipped code does something, and a double that
 * re-states what it should do cannot tell us that. `WebSessionStore` keeps its
 * client in a private field and takes it from a URL, so the instance is built
 * without the constructor and handed a fake — every method below (`create`,
 * `get`, `touch`, `destroy`) is the shipped one, including the `EX` it picks.
 */
function liveStore() {
  const rows = new Map<string, string>();
  /** Every write, with the TTL it was given — this is what "the record slides" means. */
  const writes: { key: string; ttl: number }[] = [];
  const redis = {
    async set(key: string, value: string, mode: string, ttl: number): Promise<"OK"> {
      writes.push({ key, ttl });
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
  return { store, rows, writes };
}

function appAround(store: WebSessionStore): express.Express {
  const app = express();
  app.use(cookieParser());
  app.use(
    createWebSessionMiddleware(store, {
      redisUrl: "",
      cookieSecure: false,
      isProduction: false,
    }),
  );
  app.get("/probe", (req, res) => {
    res.json({ signedIn: req.webSession !== null });
  });
  // Mirrors `POST /api/v1/auth/logout`, which is `destroyWebSession()` and
  // nothing else that touches this cookie.
  app.post("/sign-out", async (req, res) => {
    await req.destroyWebSession();
    res.json({ ok: true });
  });
  return app;
}

async function call(
  app: express.Express,
  method: "GET" | "POST",
  path: string,
  cookie: string,
): Promise<{ body: unknown; setCookie: string[] }> {
  const server = http.createServer(app);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((done, failed) => {
      const request = http.request(
        { host: "127.0.0.1", port, path, method, headers: { cookie } },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            done({
              body: data.length > 0 ? JSON.parse(data) : null,
              setCookie: response.headers["set-cookie"] ?? [],
            });
          });
        },
      );
      request.on("error", failed);
      request.end();
    });
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}

/** `Max-Age=2592000` out of one `Set-Cookie` line, in seconds. */
function maxAgeOf(setCookie: string): number | null {
  const found = /Max-Age=(\d+)/i.exec(setCookie);
  return found === null ? null : Number(found[1]);
}

function sessionCookies(setCookie: readonly string[]): string[] {
  return setCookie.filter((line) => line.startsWith(`${COOKIE_NAME}=`));
}

describe("the window a signed-in browser gets", () => {
  it("is never shorter than the one an installed app gets", () => {
    // The defect, stated as the relation it broke. A future change that
    // lengthens the app's window and forgets the browser fails here by
    // construction, without this file knowing either number.
    expect(
      TTL.SESSION,
      "a browser session shorter than the installed app's is the asymmetry that read as `push works in the PWA only`",
    ).toBeGreaterThanOrEqual(TTL.SESSION_PWA);
  });

  it("is long enough that a tab left alone over a holiday is still signed in", () => {
    // Not a pin: a lower bound with a reason. Nothing in a backgrounded tab
    // re-arms the window — the pollers do not tick unfocused,
    // `refetchOnWindowFocus` is off, and the SSE stream is one long-lived
    // request — so the window has to cover a real absence, not a workday.
    expect(TTL.SESSION).toBeGreaterThanOrEqual(14 * DAY_SECONDS);
  });

  it("has a cookie whose lifetime is DERIVED from it, not typed beside it", () => {
    // The half-repair guard. `maxAge` must be computed from the same
    // constant; a literal there would let the two drift and the browser would
    // keep signing out with a perfectly healthy record in Redis.
    expect(
      SESSION_SOURCE,
      "session.ts no longer derives the cookie's maxAge from TTL.SESSION — the cookie, not the Redis key, is what expires first",
    ).toMatch(/maxAge:\s*TTL\.SESSION\s*\*\s*1000/);
    expect(SESSION_SOURCE).toMatch(/maxAge:\s*TTL\.SESSION_PWA\s*\*\s*1000/);
  });

  it("slides BOTH halves forward on use, not just the record", async () => {
    // The window is only tolerable because it renews on activity: somebody who
    // uses the cabinet weekly never meets it at all. If the sliding goes, the
    // month becomes an absolute cap measured from sign-in — a different and
    // worse thing — and if only ONE half slides it is worse still.
    //
    // This used to be two `toMatch` calls against the source text of
    // `session.ts` (`/res\.cookie\(/` and `/touch\s*\(/`), and neither could
    // fail: `res.cookie(` also appears in `createWebSession` and in
    // `markSessionStandalone`, and `/touch\s*\(/` matches the DECLARATION
    // `async touch(sessionId: string, ip: string)`. Deleting the middleware's
    // cookie re-issue AND the `store.touch` call together left both regexes
    // green. So the request is made for real here instead.
    const { store, writes } = liveStore();
    const sessionId = await store.create({ userId: "u-1" }, "127.0.0.1");
    const atSignIn = writes.length;

    const { setCookie } = await call(
      appAround(store),
      "GET",
      "/probe",
      `${COOKIE_NAME}=${sessionId}`,
    );

    // The record's half.
    expect(
      writes.slice(atSignIn).map((write) => write.ttl),
      "one authenticated request left the session record untouched: the Redis TTL no longer slides, so the window is an absolute cap counted from sign-in and a daily user is signed out on a schedule",
    ).toEqual([TTL.SESSION]);

    // The cookie's half — the binding one, because the browser stops SENDING
    // the id before Redis forgets it, and a live record nobody presents is not
    // a session.
    const [reissued] = sessionCookies(setCookie);
    expect(
      reissued,
      "an authenticated request answered without re-issuing the session cookie. The record slid forward and the cookie did not, so the browser goes quiet while a healthy session is still in Redis — the silent sign-out this whole file is about",
    ).toBeDefined();
    expect(
      maxAgeOf(reissued ?? ""),
      "the re-issued cookie does not carry the full window, so each request shortens what is left rather than renewing it",
    ).toBe(TTL.SESSION);

    // …and the pair, in the order that matters: the cookie must never be the
    // first of the two to go.
    expect(maxAgeOf(reissued ?? "")).toBeGreaterThanOrEqual(
      writes[writes.length - 1]?.ttl ?? Number.POSITIVE_INFINITY,
    );
  });

  it("ends on sign-out, cookie included, in the same response that slid it", async () => {
    // Raising the window from a day to a month multiplies the cost of a
    // sign-out that only half works by thirty. And this response carries TWO
    // `Set-Cookie` lines for the same name — the middleware slides the cookie
    // on the way in, the handler expires it on the way out — so the ORDER is
    // the whole contract: the browser applies them in sequence and only the
    // last one survives.
    const { store, rows } = liveStore();
    const sessionId = await store.create({ userId: "u-1" }, "127.0.0.1");
    const app = appAround(store);

    const { setCookie } = await call(
      app,
      "POST",
      "/sign-out",
      `${COOKIE_NAME}=${sessionId}`,
    );

    const issued = sessionCookies(setCookie);
    expect(issued.length).toBeGreaterThan(0);
    expect(
      issued[issued.length - 1],
      "the last thing a sign-out says about the session cookie is not an expiry, so the browser keeps sending the id for the rest of the month and the customer is signed out only until the next reload",
    ).toMatch(/Expires=Thu, 01 Jan 1970/);

    // The record, not merely the reference to it. There is no index from a user
    // to their sessions, so a record left behind is a record nothing will ever
    // delete.
    expect(rows.size, "the session record outlived the sign-out").toBe(0);

    // And the id itself is spent.
    const after = await call(app, "GET", "/probe", `${COOKIE_NAME}=${sessionId}`);
    expect((after.body as { signedIn: boolean }).signedIn).toBe(false);
  });
});
