import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import express from "express";
import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRouter } from "../../src/api/routes/subscription.js";
import { UpstreamError } from "../../src/core/errors/index.js";

/**
 * `POST /api/v1/subscription/:subscriptionId/connect-help/dismiss` — × on the
 * dashboard's «Не получилось подключиться?».
 *
 * Three promises this hop makes, each a line that could quietly stop being
 * true without anything else going red:
 *
 *   1. the customer is the SESSION's — never a user named in the body, the
 *      query or anything else the browser sent; the panel checks that the
 *      subscription is that user's, so the identity sent is the whole guard;
 *   2. the subscription id comes from the path, verbatim, and must look like
 *      one — a state-changing call is refused before it is put into anything;
 *   3. a panel older than the banner answers 404 for the route, and that is
 *      "nothing to record", not an error: the SPA has already hidden the banner.
 *
 * Socket-free, like `subscriptions-all-connect-signature.test.ts`: a request is
 * driven straight through the app function, so no port is bound.
 */

type Dismiss = (identity: Record<string, unknown>, subscriptionId: string) => Promise<unknown>;

function makeApp(options: {
  readonly dismiss?: Dismiss;
  readonly session?: Record<string, unknown> | null;
  readonly noAdminClient?: boolean;
}) {
  const destroyed = { count: 0 };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const session = options.session === undefined ? { userId: "user-cuid-1" } : options.session;
    if (session !== null) {
      req.webSession = { ...session, createdAt: 0, ip: "127.0.0.1", lastActivity: 0 } as never;
      (req as unknown as { destroyWebSession: () => Promise<void> }).destroyWebSession = async () => {
        destroyed.count += 1;
      };
    }
    next();
  });
  app.use(
    "/api/v1",
    createSubscriptionRouter({
      adminClient: options.noAdminClient
        ? null
        : ({ subscription: { dismissConnectHelp: options.dismiss ?? (async () => ({ ok: true })) } } as never),
      sessionStore: null,
      config: {} as never,
    }),
  );
  return { app, destroyed };
}

/** One request through the app, with no port bound. */
function drive(
  app: express.Express,
  input: { readonly url: string; readonly body?: string },
): Promise<{ status: number; json: unknown }> {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  const request = new IncomingMessage(socket);
  request.method = "POST";
  request.url = input.url;
  request.headers = {
    host: "127.0.0.1",
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

const PATH = "/api/v1/subscription/cmsub0001abcdefghijklmno/connect-help/dismiss";

describe("who is dismissing", () => {
  it("refuses a caller with no session, without asking the panel", async () => {
    const dismiss = vi.fn<Dismiss>(async () => ({ ok: true }));
    const { app } = makeApp({ dismiss, session: null });

    const reply = await drive(app, { url: PATH });

    expect(reply.status).toBe(401);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("sends the SESSION's identity upstream, not anything the request named", async () => {
    // If the identity ever came from the body or the query, any signed-in
    // customer could switch off another customer's banner by editing a request.
    const dismiss = vi.fn<Dismiss>(async () => ({ ok: true }));
    const { app } = makeApp({ dismiss, session: { userId: "user-cuid-1" } });

    await drive(app, {
      url: `${PATH}?userId=someone-else&telegramId=999`,
      body: JSON.stringify({ userId: "someone-else", telegramId: "999", subscriptionId: "other-sub" }),
    });

    expect(dismiss).toHaveBeenCalledTimes(1);
    const [identity, subscriptionId] = dismiss.mock.calls[0] as [Record<string, unknown>, string];
    expect(identity).toEqual({ userId: "user-cuid-1" });
    expect(JSON.stringify(identity)).not.toContain("someone-else");
    expect(JSON.stringify(identity)).not.toContain("999");
    expect(subscriptionId).toBe("cmsub0001abcdefghijklmno");
  });
});

describe("which subscription", () => {
  it("passes the id from the path, verbatim", async () => {
    const dismiss = vi.fn<Dismiss>(async () => ({ ok: true }));
    const { app } = makeApp({ dismiss });

    const reply = await drive(app, { url: PATH });

    expect(reply).toEqual({ status: 200, json: { dismissed: true } });
    expect(dismiss.mock.calls[0]?.[1]).toBe("cmsub0001abcdefghijklmno");
  });

  it("refuses an id that could reshape the upstream path, before any call", async () => {
    const dismiss = vi.fn<Dismiss>(async () => ({ ok: true }));
    const { app } = makeApp({ dismiss });

    for (const id of ["..%2F..%2Fdevices", "a%20b", "x".repeat(129), "%00"]) {
      const reply = await drive(app, { url: `/api/v1/subscription/${id}/connect-help/dismiss` });
      expect(reply.status, id).toBe(400);
    }
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe("what the panel answered", () => {
  it("answers 'nothing to record' for a panel older than the banner", async () => {
    const dismiss = vi.fn<Dismiss>(async () => {
      throw new UpstreamError(
        "POST",
        "/api/internal/user/user-cuid-1/subscriptions/cmsub0001abcdefghijklmno/connect-help/dismiss",
        404,
        JSON.stringify({ statusCode: 404, message: "Cannot POST /api/internal/user/…", error: "Not Found" }),
      );
    });
    const { app, destroyed } = makeApp({ dismiss });

    const reply = await drive(app, { url: PATH });

    expect(reply).toEqual({ status: 200, json: { dismissed: false } });
    // An ordinary 404 is not a dead account: the session stays.
    expect(destroyed.count).toBe(0);
  });

  it("ends the session of an account the panel no longer has", async () => {
    const dismiss = vi.fn<Dismiss>(async () => {
      throw new UpstreamError("POST", "/api/internal/user/x/subscriptions/y/connect-help/dismiss", 404, "User not found");
    });
    const { app, destroyed } = makeApp({ dismiss });

    const reply = await drive(app, { url: PATH });

    expect(reply.status).toBe(401);
    expect(destroyed.count).toBe(1);
  });

  it("reports any other failure as one, without the panel's words", async () => {
    const dismiss = vi.fn<Dismiss>(async () => {
      throw new UpstreamError("POST", "/api/internal/user/x/subscriptions/y/connect-help/dismiss", 500, "stack trace at /srv/secret");
    });
    const { app } = makeApp({ dismiss });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reply = await drive(app, { url: PATH });

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.json)).not.toContain("secret");
    expect(JSON.stringify(reply.json)).not.toContain("/api/internal");
    errors.mockRestore();
  });

  it("answers 'nothing to record' when there is no panel connection at all", async () => {
    const { app } = makeApp({ noAdminClient: true });

    const reply = await drive(app, { url: PATH });

    expect(reply).toEqual({ status: 200, json: { dismissed: false } });
  });
});
