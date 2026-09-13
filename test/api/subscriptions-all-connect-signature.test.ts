import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/app.js";
import { createConnectHandoffSigner } from "../../src/api/lib/connect-handoff-signature.js";

/**
 * `GET /api/v1/subscriptions/all` SIGNS THE SESSION USER'S OWN SUBSCRIPTION
 * URLS, AND THE VERIFY ROUTE OF THE SAME CABINET ACCEPTS WHAT IT SIGNED.
 *
 * This is the only place a signature is ever produced, and the connect screen
 * reads it from here to put in the `/connect/open` address. Driven through the
 * real `createApp` so both halves meet the way they do in production: the list
 * route and the verify route build separate signers from one config, and a
 * signature only means something if the second accepts what the first made —
 * with the shared secret, and without it in development.
 *
 * Socket-free on purpose, like `health-readiness.test.ts`. The same cases over
 * real sockets reproducibly hit the Windows fork-worker death that
 * `vitest.config.ts` documents — here, at a fixed point in this file's
 * sequence — and a spec that kills its worker proves nothing either way.
 */

const SECRET = "shared-secret-of-this-installation-0123456789";
const URL_A = "https://sub.example.test/s/AbC123";
const URL_B = "https://sub.example.test/s/XyZ789";

const ROWS = [
  { id: "sub-1", status: "ACTIVE", url: URL_A, expiresAt: "2100-01-01T00:00:00.000Z", plan: { id: "p1", name: "Plan", type: null } },
  { id: "sub-2", status: "EXPIRED", url: null, expiresAt: null, plan: null },
  { id: "sub-3", status: "ACTIVE", url: URL_B, expiresAt: null, plan: null },
];

type Row = Record<string, unknown>;

function digestOf(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("base64url");
}

function build(secret: string | undefined) {
  const getAll = vi.fn(async () => ({ subscriptions: ROWS.map((row) => ({ ...row })) }));
  const app = createApp({
    adminClient: { subscription: { getAll } } as never,
    // The legacy Telegram session: a cookie the store resolves. The web-session
    // middleware needs Redis, and the route accepts either kind.
    sessionStore: {
      get: async (id: string) =>
        id === "live-session"
          ? { telegramId: "4242", userId: 7, name: "subscriber", role: "user", createdAt: 0 }
          : null,
      refresh: async () => undefined,
    } as never,
    webSessionStore: null,
    config: {
      NODE_ENV: "test",
      REIWA_BOT_INTERNAL_URL: "http://127.0.0.1:1",
      REZEIS_INTERNAL_SHARED_SECRET: secret,
    } as never,
  });
  return { app, getAll };
}

/** One request through the whole app pipeline, with no port bound. */
function drive(
  app: ReturnType<typeof createApp>,
  input: { method: "GET" | "POST"; url: string; body?: string; cookie?: string },
): Promise<{ status: number; json: unknown }> {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  const request = new IncomingMessage(socket);
  request.method = input.method;
  request.url = input.url;
  request.headers = {
    host: "127.0.0.1",
    // The page's own POST is same-origin and carries that Origin.
    origin: "http://127.0.0.1",
    ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
    ...(input.body === undefined
      ? {}
      : { "content-type": "application/json", "content-length": String(Buffer.byteLength(input.body)) }),
  };
  const response = new ServerResponse(request);

  const chunks: string[] = [];
  const settled = new Promise<{ status: number; json: unknown }>((resolve) => {
    (response as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
      if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
      return true;
    };
    (response as unknown as { end: unknown }).end = (chunk?: unknown): ServerResponse => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) chunks.push(String(chunk));
      const raw = chunks.join("");
      resolve({ status: response.statusCode, json: raw.length > 0 ? JSON.parse(raw) : undefined });
      return response;
    };
  });

  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(request, response);
  if (input.body !== undefined) request.push(input.body);
  request.push(null);
  return settled;
}

async function listFor(app: ReturnType<typeof createApp>): Promise<Row[]> {
  const reply = await drive(app, { method: "GET", url: "/api/v1/subscriptions/all", cookie: "reiwa_session=live-session" });
  expect(reply.status).toBe(200);
  return (reply.json as { subscriptions: Row[] }).subscriptions;
}

async function verify(app: ReturnType<typeof createApp>, url: string, signature: unknown): Promise<unknown> {
  const reply = await drive(app, {
    method: "POST",
    url: "/api/v1/connect/handoff/verify",
    body: JSON.stringify({ digest: digestOf(url), signature }),
  });
  expect(reply.status, "the verify route refused the shape of what the list route produced").toBe(200);
  return reply.json;
}

describe("GET /subscriptions/all signs each subscription that has a url", () => {
  it("adds this installation's signature over each url and changes nothing else", async () => {
    const { app } = build(SECRET);
    const rows = await listFor(app);
    const signer = createConnectHandoffSigner(SECRET);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ ...ROWS[0], connectSignature: signer.sign(URL_A) });
    expect(rows[2]).toEqual({ ...ROWS[2], connectSignature: signer.sign(URL_B) });
    // No url, nothing to sign, and no empty key standing in for one.
    expect(rows[1]).toEqual(ROWS[1]);
  });

  it("produces nothing for a caller with no session", async () => {
    const { app, getAll } = build(SECRET);
    const reply = await drive(app, { method: "GET", url: "/api/v1/subscriptions/all" });

    expect(reply.status).toBe(401);
    expect(JSON.stringify(reply.json)).not.toContain("connectSignature");
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe("what the list signs, the verify route of the same cabinet accepts", () => {
  it.each([
    ["with the shared secret", SECRET],
    // Development: no secret, one random key per process — which both routes
    // must share, or no address would ever verify on a developer's machine.
    ["without it, within one process", undefined],
  ])("%s", async (_name, secret) => {
    const { app } = build(secret);
    const rows = await listFor(app);

    expect(await verify(app, URL_A, rows[0]?.["connectSignature"])).toEqual({ valid: true });
    expect(await verify(app, URL_B, rows[2]?.["connectSignature"])).toEqual({ valid: true });
    // And one subscription's signature says nothing about the other's.
    expect(await verify(app, URL_B, rows[0]?.["connectSignature"])).toEqual({ valid: false });
  });
});
