import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/app.js";

/**
 * `GET /api/v1/subscriptions/all` carries the panel's `connectHelp` to the
 * browser untouched.
 *
 * The dashboard's banner and deep link read it off each subscription:
 * `{ pending, banner }` from a panel that has the feature, `null` when nothing
 * is owed, and NO key at all from a panel older than it — which the cabinet
 * reads as "nothing owed". This hop re-signs every row's url on the way
 * through; a rewrite of that step that rebuilt the rows field by field would
 * drop the flags, and the banner would never appear for anybody, with nothing
 * failing anywhere. So the three shapes are pinned end to end, through the real
 * app, with the session a real middleware resolves.
 *
 * Socket-free, like `subscriptions-all-connect-signature.test.ts`.
 */

const ROWS = [
  {
    id: "sub-1",
    status: "ACTIVE",
    url: "https://sub.example.test/s/one",
    connectHelp: { pending: true, banner: true },
  },
  { id: "sub-2", status: "ACTIVE", url: "https://sub.example.test/s/two", connectHelp: null },
  // A panel older than the feature: no key at all.
  { id: "sub-3", status: "ACTIVE", url: "https://sub.example.test/s/three" },
];

function build() {
  const getAll = vi.fn(async () => ({ subscriptions: ROWS.map((row) => ({ ...row })) }));
  const app = createApp({
    adminClient: { subscription: { getAll } } as never,
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
      REZEIS_INTERNAL_SHARED_SECRET: "shared-secret-of-this-installation-0123456789",
    } as never,
  });
  return { app, getAll };
}

function drive(app: ReturnType<typeof createApp>, url: string): Promise<{ status: number; json: unknown }> {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = url;
  request.headers = { host: "127.0.0.1", origin: "http://127.0.0.1", cookie: "reiwa_session=live-session" };
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
  request.push(null);
  return settled;
}

describe("GET /subscriptions/all and connectHelp", () => {
  it("relays each of the three shapes exactly as the panel sent it", async () => {
    const { app, getAll } = build();

    const reply = await drive(app, "/api/v1/subscriptions/all");

    expect(reply.status).toBe(200);
    expect(getAll).toHaveBeenCalledTimes(1);
    const rows = (reply.json as { subscriptions: Array<Record<string, unknown>> }).subscriptions;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.["connectHelp"]).toEqual({ pending: true, banner: true });
    expect(rows[1]?.["connectHelp"]).toBeNull();
    // Absent stays ABSENT — not `null`, not `{ pending: false, … }` made up here.
    expect(Object.hasOwn(rows[2] ?? {}, "connectHelp")).toBe(false);
    // Anti-vacuity: this really is the hop that rewrites the rows.
    expect(typeof rows[0]?.["connectSignature"]).toBe("string");
  });
});
