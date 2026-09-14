import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/api/app.js";
import { createConnectHandoffSigner } from "../../src/api/lib/connect-handoff-signature.js";

/**
 * `POST /api/v1/connect/handoff/verify` — THE ONE QUESTION THE PUBLIC
 * `/connect/open` PAGE ASKS, ANSWERED FOR ANYBODY AND ABOUT NOBODY.
 *
 * The page opens in a browser with no session and asks whether this cabinet
 * signed the subscription inside its link, sending the SHA-256 of the url and
 * the signature and nothing else. Everything here runs through the real
 * `createApp`, because what this route promises is decided as much by the
 * pipeline around it as by the handler:
 *
 *   - it answers WITHOUT a session — the page never has one;
 *   - it says yes only to this installation's signature over the digest sent;
 *   - it refuses anything but exactly `{ digest, signature }`, well formed, with
 *     a 400 of its own — a body that is not JSON included, which the app's
 *     global error handler would otherwise answer with its generic 400 and no
 *     `no-store`;
 *   - nothing it answers is cacheable;
 *   - the CSRF guard still refuses another origin — nothing was loosened;
 *   - no log line holds the body or anything from it.
 */

const SECRET = "shared-secret-of-this-installation-0123456789";
const URL_A = "https://sub.example.test/s/AbC123";

function digestOf(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("base64url");
}

const SIGNER = createConnectHandoffSigner(SECRET);
const DIGEST = digestOf(URL_A);
const SIGNATURE = SIGNER.sign(URL_A);

interface Reply {
  readonly status: number;
  readonly cacheControl: string | undefined;
  readonly text: string;
  readonly json: unknown;
}

interface Running {
  readonly port: number;
  send(input: { body?: string; headers?: Record<string, string>; method?: string; path?: string }): Promise<Reply>;
  close(): Promise<void>;
}

function buildApp(options: { secret?: string; logger?: pino.Logger } = {}): ReturnType<typeof createApp> {
  return createApp({
    adminClient: null,
    sessionStore: null,
    webSessionStore: null,
    config: {
      NODE_ENV: "test",
      REIWA_BOT_INTERNAL_URL: "http://127.0.0.1:1",
      REZEIS_INTERNAL_SHARED_SECRET: options.secret,
    } as never,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

async function serve(app: ReturnType<typeof createApp>): Promise<Running> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    send: ({ body, headers = {}, method = "POST", path = "/api/v1/connect/handoff/verify" }) =>
      new Promise<Reply>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            headers: {
              // The page's own request: same origin, so it carries that Origin.
              origin: `http://127.0.0.1:${port}`,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }),
              ...headers,
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
              const cacheControl = response.headers["cache-control"];
              resolve({ status: response.statusCode ?? 0, cacheControl, text, json });
            });
          },
        );
        request.on("error", reject);
        request.end(body);
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withApp<T>(app: ReturnType<typeof createApp>, run: (running: Running) => Promise<T>): Promise<T> {
  const running = await serve(app);
  try {
    return await run(running);
  } finally {
    await running.close();
  }
}

const verifyBody = (digest: string, signature: string): string => JSON.stringify({ digest, signature });

describe("the answer", () => {
  it("is yes for this installation's signature over the digest sent — with no session, and never cached", async () => {
    await withApp(buildApp({ secret: SECRET }), async ({ send }) => {
      // No cookie of any kind: the page runs where the Mini App's session is not.
      const reply = await send({ body: verifyBody(DIGEST, SIGNATURE) });

      expect(reply.status, reply.text).toBe(200);
      expect(reply.json).toEqual({ valid: true });
      expect(reply.cacheControl).toBe("no-store");
    });
  });

  it("is no for a genuine signature sent with another subscription's digest", async () => {
    await withApp(buildApp({ secret: SECRET }), async ({ send }) => {
      const reply = await send({ body: verifyBody(digestOf("https://evil.example.test/sub"), SIGNATURE) });

      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ valid: false });
      expect(reply.cacheControl).toBe("no-store");
    });
  });

  it("is no for a signature another installation made", async () => {
    const theirs = createConnectHandoffSigner("shared-secret-of-another-installation-987654321").sign(URL_A);
    await withApp(buildApp({ secret: SECRET }), async ({ send }) => {
      const reply = await send({ body: verifyBody(DIGEST, theirs) });

      expect(reply.json).toEqual({ valid: false });
    });
  });
});

describe("anything but exactly { digest, signature } is a 400", () => {
  it.each([
    ["no body at all", undefined],
    ["an empty object", "{}"],
    ["a digest alone", JSON.stringify({ digest: DIGEST })],
    ["a signature one character short", verifyBody(DIGEST, SIGNATURE.slice(0, 42))],
    ["a digest one character long", verifyBody(`${DIGEST}A`, SIGNATURE)],
    ["padding", verifyBody(DIGEST, `${SIGNATURE}=`)],
    ["the standard base64 alphabet", verifyBody(`+${DIGEST.slice(1)}`, SIGNATURE)],
    ["numbers", JSON.stringify({ digest: 1, signature: 2 })],
    // The field the page must never send. A request carrying it did not come
    // from the page, and answering it would teach a client it may send it.
    ["the subscription url riding along", JSON.stringify({ digest: DIGEST, signature: SIGNATURE, subscriptionUrl: URL_A })],
    ["an array", JSON.stringify([DIGEST, SIGNATURE])],
    ["a JSON string", JSON.stringify(`${DIGEST}.${SIGNATURE}`)],
    // Refused by the global JSON parser before any route runs — the case the
    // route's own error handler exists for.
    ["a body that is not JSON", `{"digest":"${DIGEST}","signature":"${SIGNATURE}"`],
  ])("%s", async (_name, body) => {
    await withApp(buildApp({ secret: SECRET }), async ({ send }) => {
      const reply = await send(body === undefined ? {} : { body });

      expect(reply.status, reply.text).toBe(400);
      expect(reply.cacheControl).toBe("no-store");
      expect(reply.text).not.toContain(SIGNATURE);
    });
  });
});

describe("nothing around it was loosened", () => {
  it("still refuses a POST from another origin", async () => {
    await withApp(buildApp({ secret: SECRET }), async ({ send }) => {
      const reply = await send({ body: verifyBody(DIGEST, SIGNATURE), headers: { origin: "https://evil.example.test" } });

      expect(reply.status).toBe(403);
      expect(reply.json).toEqual({ message: "Forbidden: origin not allowed" });
    });
  });

  it("leaves a body the parser refuses on ANOTHER route to whatever answered it before", async () => {
    // The route's error handler is scoped to its own path. If it ever swallowed
    // other routes' parse errors it would change their answers silently. What
    // the global handler answers is deliberately not pinned here.
    await withApp(buildApp({ secret: SECRET }), async ({ send }) => {
      const reply = await send({ body: "{not json", path: "/api/v1/client-errors" });

      expect(reply.cacheControl).not.toBe("no-store");
      expect(reply.text).not.toContain("digest and signature");
    });
  });
});

describe("the log", () => {
  it("holds neither the body nor the digest or signature in it — for a yes, a refusal, or a body that is not JSON", async () => {
    let captured = "";
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        captured += chunk.toString("utf8");
        done();
      },
    });
    const logger = pino({ level: "trace" }, sink);
    const marker = "https://marker.example.test/s/never-in-a-log";
    const markerDigest = digestOf(marker);

    await withApp(buildApp({ secret: SECRET, logger }), async ({ send }) => {
      expect((await send({ body: verifyBody(DIGEST, SIGNATURE) })).status).toBe(200);
      expect((await send({ body: verifyBody(markerDigest, SIGNATURE.slice(0, 42)) })).status).toBe(400);
      expect(
        (await send({ body: `{"digest":"${markerDigest}","signature":"${SIGNATURE}","u":"${marker}"` })).status,
      ).toBe(400);
    });

    // Otherwise every assertion below would hold for a logger that wrote nothing.
    expect(captured, "the logger captured nothing, so this case proves nothing").toContain(
      "/api/v1/connect/handoff/verify",
    );
    expect(captured).not.toContain(SIGNATURE);
    expect(captured).not.toContain(SIGNATURE.slice(0, 42));
    expect(captured).not.toContain(DIGEST);
    expect(captured).not.toContain(markerDigest);
    expect(captured).not.toContain("marker.example.test");
  });
});
