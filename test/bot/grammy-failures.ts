/**
 * Real grammY failures, made by grammY's own client against sockets on this
 * machine.
 *
 * A hand-built error has whatever shape its author expected, and a spec about
 * failed sends — what the listener answers, what it logs — then agrees with
 * itself. These come from the path a production send takes instead: `Api` ->
 * node-fetch -> a socket, with the bot token in the request URL exactly where
 * grammY puts it.
 *
 * Measured on Node 24 / grammY 1.46 (node-fetch 2.7):
 *  - a refused connection: `HttpError` wrapping node-fetch's `FetchError` with
 *    `code: 'ECONNREFUSED'`, message `request to …/bot<TOKEN>/sendMessage
 *    failed, reason: connect ECONNREFUSED 127.0.0.1:<port>`;
 *  - a request that was written and then reset: the same wrapper,
 *    `code: 'ECONNRESET'`, `reason: socket hang up`;
 *  - an HTML 502 in front of the Bot API: `FetchError` `type: 'invalid-json'`,
 *    no code;
 *  - grammY's own deadline: a plain `Error`, no code;
 *  - a JSON 5xx: a `GrammyError` that holds the request `payload`.
 *
 * All but the refused connection reached the server first (`requestsReceived`):
 * the message could exist when they fail.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { Api, GrammyError, HttpError } from 'grammy';

/** Shaped like a real token; only ever sent to 127.0.0.1. */
export const FAKE_BOT_TOKEN = '123456789:AAHfakeTokenForSpecsOnly_0123456789ab';

export interface GrammyFailures {
  /** Nothing listened: the connection was refused, no request was written. */
  readonly refused: HttpError;
  /** The server read the whole request, then reset the socket. */
  readonly resetAfterRequest: HttpError;
  /** The server read the whole request, then answered 502 with an HTML page. */
  readonly htmlBadGateway: HttpError;
  /** The server read the whole request and never answered; grammY gave up. */
  readonly timedOut: HttpError;
  /** The server read the whole request and answered a JSON 500. */
  readonly serverError: GrammyError;
  /** Requests each server actually received — proof the message could exist. */
  readonly requestsReceived: {
    readonly resetAfterRequest: number;
    readonly htmlBadGateway: number;
    readonly timedOut: number;
    readonly serverError: number;
  };
}

/** A local "Bot API" that reads each request to the end, then does `then`. */
async function localBotApi(
  then: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ readonly apiRoot: string; readonly received: () => number; readonly close: () => Promise<void> }> {
  let received = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received += 1;
      then(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    received: () => received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function failureOf<T>(call: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await call;
  } catch (err: unknown) {
    if (err instanceof type) return err;
    throw new Error(`expected ${type.name}, got ${String(err)}`, { cause: err });
  }
  throw new Error(`expected ${type.name}, but the call succeeded`);
}

/**
 * One of each. `text` is the message every call sends, so a spec can look for
 * it where it must not appear. Takes a little over a second: grammY's shortest
 * deadline is one second.
 */
export async function captureGrammyFailures(text = 'grammy-failures: message text'): Promise<GrammyFailures> {
  const port = await closedPort();
  const refused = await failureOf(
    new Api(FAKE_BOT_TOKEN, { apiRoot: `http://127.0.0.1:${port}` }).sendMessage(1, text),
    HttpError,
  );

  const reset = await localBotApi((req) => req.socket.destroy());
  const html = await localBotApi((_req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  });
  const silent = await localBotApi(() => {});
  const json500 = await localBotApi((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }));
  });
  try {
    const resetAfterRequest = await failureOf(
      new Api(FAKE_BOT_TOKEN, { apiRoot: reset.apiRoot }).sendMessage(1, text),
      HttpError,
    );
    const htmlBadGateway = await failureOf(
      new Api(FAKE_BOT_TOKEN, { apiRoot: html.apiRoot }).sendMessage(1, text),
      HttpError,
    );
    const timedOut = await failureOf(
      new Api(FAKE_BOT_TOKEN, { apiRoot: silent.apiRoot, timeoutSeconds: 1 }).sendMessage(1, text),
      HttpError,
    );
    const serverError = await failureOf(
      new Api(FAKE_BOT_TOKEN, { apiRoot: json500.apiRoot }).sendMessage(1, text),
      GrammyError,
    );
    return {
      refused,
      resetAfterRequest,
      htmlBadGateway,
      timedOut,
      serverError,
      requestsReceived: {
        resetAfterRequest: reset.received(),
        htmlBadGateway: html.received(),
        timedOut: silent.received(),
        serverError: json500.received(),
      },
    };
  } finally {
    await Promise.all([reset.close(), html.close(), silent.close(), json500.close()]);
  }
}
