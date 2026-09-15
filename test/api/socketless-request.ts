/**
 * One request through an Express app with no port bound.
 *
 * The pattern `health-readiness.test.ts` and
 * `subscriptions-all-connect-signature.test.ts` use, for their reason: the same
 * cases over real sockets reproducibly hit the Windows fork-worker death that
 * `vitest.config.ts` documents, and a spec that kills its worker proves nothing
 * either way. The whole Express pipeline still runs — parsers, session guards,
 * limiters, handlers — only the socket is missing.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

export interface SocketlessResponse {
  readonly status: number;
  /** Lower-cased names, as `ServerResponse#getHeaders` gives them. */
  readonly headers: Readonly<Record<string, number | string | string[] | undefined>>;
  readonly body: unknown;
}

export interface SocketlessRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as JSON when present. */
  readonly body?: unknown;
}

export function sendSocketless(app: unknown, input: SocketlessRequest): Promise<SocketlessResponse> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  const request = new IncomingMessage(socket);
  request.method = input.method;
  request.url = input.url;
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  const headers: Record<string, string> = { host: '127.0.0.1' };
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  request.headers = headers;
  const response = new ServerResponse(request);

  const chunks: Buffer[] = [];
  const collect = (chunk: unknown): void => {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  };
  const settled = new Promise<SocketlessResponse>((resolve) => {
    (response as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
      collect(chunk);
      return true;
    };
    (response as unknown as { end: unknown }).end = (chunk?: unknown): ServerResponse => {
      collect(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        // Not JSON: keep the text.
      }
      resolve({ status: response.statusCode, headers: response.getHeaders(), body });
      return response;
    };
  });

  (app as (req: IncomingMessage, res: ServerResponse) => void)(request, response);
  if (payload !== undefined) request.push(payload);
  request.push(null);
  return settled;
}
