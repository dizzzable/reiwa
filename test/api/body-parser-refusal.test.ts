import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/app.js";

/**
 * A REQUEST BODY THE PARSER REFUSES IS THE CLIENT'S MISTAKE, AND IS ANSWERED AS
 * ONE — WITHOUT A WORD OF THE BODY IN THE LOG OR IN THE PANEL.
 *
 * `express.json` runs before every route, so JSON that does not parse, a body
 * over the limit, or a charset or content encoding it cannot read never reaches
 * a handler: body-parser hands its refusal straight to the app's error handler.
 * That handler used to take the unreadable-JSON refusal for a crash:
 *
 *   - it answered 500, telling the client the server broke on a request the
 *     server merely could not read;
 *   - it reported it to the panel as a server error, one operator event for
 *     every malformed request anybody cares to send;
 *   - it logged the error whole, and body-parser keeps the text it could not
 *     parse on that error as `body` — pino writes every field of an `err`, and
 *     Node's own JSON.parse message quotes the start of the text as well.
 *
 * Everything here runs through the real `createApp`: the refusal is raised by
 * app-level middleware, so only the whole pipeline shows who answers it.
 */

/** Unique enough that finding it anywhere means the body got there. */
const MARKER = "body-marker-7f3a91-never-in-a-log";

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
}

function harness() {
  let log = "";
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      log += chunk.toString("utf8");
      done();
    },
  });
  const reportError = vi.fn(async (_report: unknown) => undefined);
  const app = createApp({
    adminClient: { system: { reportError } } as never,
    sessionStore: null,
    webSessionStore: null,
    config: { NODE_ENV: "test", REIWA_BOT_INTERNAL_URL: "http://127.0.0.1:1" } as never,
    logger: pino({ level: "trace" }, sink),
  });
  return { app, reportError, log: () => log };
}

async function send(
  app: ReturnType<typeof createApp>,
  input: { path: string; body: string | Buffer; headers?: Record<string, string> },
): Promise<Reply> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<Reply>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: input.path,
          method: "POST",
          headers: {
            origin: `http://127.0.0.1:${port}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(input.body)),
            ...input.headers,
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.on("end", () => {
            let json: unknown = undefined;
            try {
              json = text.length > 0 ? JSON.parse(text) : undefined;
            } catch {
              json = undefined;
            }
            resolve({ status: response.statusCode ?? 0, text, json });
          });
        },
      );
      request.on("error", reject);
      request.end(input.body);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Lets a fire-and-forget report, if one was started, reach the stub. */
function reporterTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** An ordinary public POST route: nothing on it handles a refused body itself. */
const ROUTE = "/api/v1/auth/check-username";

describe("a body the JSON parser cannot read", () => {
  it("is a 400 with a short message, not a 500 — and neither the log nor the panel hears the body", async () => {
    const { app, reportError, log } = harness();

    const reply = await send(app, { path: ROUTE, body: `{"username":"${MARKER}","unterminated":` });
    await reporterTurn();

    expect(reply.status, reply.text).toBe(400);
    expect(reply.json).toEqual({ message: expect.any(String) });
    expect(reply.text).not.toContain(MARKER);
    // Otherwise the absence below would hold for a logger that wrote nothing.
    expect(log(), "the logger captured nothing about the request, so this case proves nothing").toContain(ROUTE);
    expect(log()).not.toContain(MARKER);
    expect(log(), "a client's refusal was logged as a server error").not.toContain('"level":50');
    expect(reportError, "a client's malformed body was reported to the panel as a server error").not.toHaveBeenCalled();
  });

  it("is refused the same way when it is not even an object", async () => {
    // body-parser's strict mode refuses a bare value with the same error type.
    const { app, reportError, log } = harness();

    const reply = await send(app, { path: ROUTE, body: `"${MARKER}"` });
    await reporterTurn();

    expect(reply.status, reply.text).toBe(400);
    expect(log()).not.toContain(MARKER);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("the parser's other refusals keep their own status", () => {
  it("answers a body over the limit with 413", async () => {
    const { app, reportError, log } = harness();
    const body = JSON.stringify({ username: MARKER, pad: "x".repeat(1024 * 1024) });

    const reply = await send(app, { path: ROUTE, body });
    await reporterTurn();

    expect(reply.status, reply.text).toBe(413);
    expect(reply.json).toEqual({ message: "Payload too large" });
    expect(log()).not.toContain(MARKER);
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    ["a charset JSON cannot be in", { "content-type": "application/json; charset=latin1" }],
    ["a content encoding the parser does not inflate", { "content-encoding": "compress" }],
  ])("answers %s with 415", async (_name, headers) => {
    const { app, reportError, log } = harness();

    const reply = await send(app, { path: ROUTE, body: JSON.stringify({ username: MARKER }), headers });
    await reporterTurn();

    expect(reply.status, reply.text).toBe(415);
    expect(reply.json).toEqual({ message: expect.any(String) });
    expect(log()).not.toContain(MARKER);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("the harness", () => {
  it("does reach the panel from this app, so the silence above is not a stub nobody calls", async () => {
    const { app, reportError } = harness();

    // The client-error ingest reports through the same admin client.
    const reply = await send(app, { path: "/api/v1/client-errors", body: JSON.stringify({ message: "control" }) });
    await reporterTurn();

    expect(reply.status).toBe(204);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
