/**
 * Every call to the panel says which process makes it and what that process
 * can do: `x-reiwa-client` and `x-reiwa-capabilities` (`core/capabilities.ts`).
 *
 * Pinned here, on a real socket, for all three ways the transport reaches the
 * panel — `request`, `openStream` and `fetchBinary`:
 *   - both headers go out, exactly as the panel reads them;
 *   - nothing a caller passes replaces them or travels beside them, in any
 *     spelling of the name;
 *   - every other caller header, the body and the signature are what they were
 *     without an identity;
 *   - an identity with characters a header cannot carry still makes a valid
 *     request. undici refuses the whole call otherwise.
 *
 * Real network, as in `transport.test.ts`: the transport builds its own pools,
 * so a swapped global dispatcher would not see these calls.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REIWA_BUILD_INFO } from '../../../src/core/version.js';
import {
  CLIENT_HEADER_MAX_LENGTH,
  type ReiwaClientIdentity,
} from '../../../src/core/capabilities.js';
import { AdminTransport } from '../../../src/infrastructure/admin-client/transport.js';
import { verifyInternalSignature } from '../../../src/lib/internal-hmac.js';

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Name/value pairs as they came off the wire, repeated names kept apart. */
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

interface Panel {
  readonly baseUrl: string;
  readonly captured: Captured[];
  close(): Promise<void>;
}

async function startPanel(): Promise<Panel> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const IDENTITY: ReiwaClientIdentity = {
  surface: 'api',
  version: '0.9.7.54',
  commit: '0123456789ab',
  instance: 'reiwa',
  capabilities: ['web.addon-reset-end', 'api.config-version-poll'],
};

const CLIENT = 'surface=api; version=0.9.7.54; commit=0123456789ab; instance=reiwa';
const CAPABILITIES = 'web.addon-reset-end,api.config-version-poll';

/** Every line with this name, whatever its case, as it came off the wire. */
function linesNamed(captured: Captured, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < captured.rawHeaders.length; index += 2) {
    if (captured.rawHeaders[index]!.toLowerCase() === name) values.push(captured.rawHeaders[index + 1]!);
  }
  return values;
}

/** Drain a streamed body so the socket goes back to its pool. */
async function drain(body: NodeJS.ReadableStream | undefined): Promise<void> {
  if (body === undefined) return;
  for await (const chunk of body as AsyncIterable<unknown>) void chunk;
}

type Path = 'request' | 'openStream' | 'fetchBinary';

/** One call along `path` with `extra` as the caller's headers. */
async function call(transport: AdminTransport, path: Path, extra?: Record<string, string>): Promise<void> {
  if (path === 'request') {
    await transport.request('POST', '/api/internal/x', { a: 1 }, extra);
  } else if (path === 'openStream') {
    await drain((await transport.openStream('/api/internal/user/u/stream', extra))?.body);
  } else {
    await drain((await transport.fetchBinary('/uploads/faq/a.mp4', extra))?.body);
  }
}

const PATHS: readonly Path[] = ['request', 'openStream', 'fetchBinary'];

let panel: Panel;
const opened: AdminTransport[] = [];

function transport(identity: ReiwaClientIdentity | null, sharedSecret: string | null = null): AdminTransport {
  const built = new AdminTransport({ baseUrl: panel.baseUrl, apiKey: 'internal-token', sharedSecret, identity });
  opened.push(built);
  return built;
}

beforeEach(async () => {
  panel = await startPanel();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((built) => built.close()));
  await panel.close();
});

describe.each(PATHS)('%s', (path) => {
  it('carries both headers, exactly as the panel reads them', async () => {
    await call(transport(IDENTITY), path);
    const [captured] = panel.captured;
    expect(linesNamed(captured!, 'x-reiwa-client')).toEqual([CLIENT]);
    expect(linesNamed(captured!, 'x-reiwa-capabilities')).toEqual([CAPABILITIES]);
  });

  it('a caller cannot replace them: the same spelling is overwritten', async () => {
    await call(transport(IDENTITY), path, {
      'x-reiwa-client': 'surface=api; version=9.9.9.9; commit=evil; instance=evil',
      'x-reiwa-capabilities': 'web.everything,panel.anything',
    });
    const [captured] = panel.captured;
    expect(linesNamed(captured!, 'x-reiwa-client')).toEqual([CLIENT]);
    expect(linesNamed(captured!, 'x-reiwa-capabilities')).toEqual([CAPABILITIES]);
  });

  it('nor travel beside them in another case: one line each, ours', async () => {
    // Left alone, undici sends `X-Reiwa-Capabilities` as a line of its own and
    // the panel reads `web.everything, web.addon-reset-end,…` — a capability
    // the process does not have.
    await call(transport(IDENTITY), path, {
      'X-Reiwa-Client': 'surface=api; version=9.9.9.9; commit=evil; instance=evil',
      'X-REIWA-CAPABILITIES': 'web.everything',
    });
    const [captured] = panel.captured;
    expect(linesNamed(captured!, 'x-reiwa-client')).toEqual([CLIENT]);
    expect(linesNamed(captured!, 'x-reiwa-capabilities')).toEqual([CAPABILITIES]);
  });

  it('passes every other caller header exactly as given', async () => {
    await call(transport(IDENTITY), path, { Range: 'bytes=0-9', 'x-support-guest-token': 'tok' });
    const [captured] = panel.captured;
    expect(linesNamed(captured!, 'range')).toEqual(['bytes=0-9']);
    expect(linesNamed(captured!, 'x-support-guest-token')).toEqual(['tok']);
    expect(captured!.headers.authorization).toBe('Bearer internal-token');
  });

  it('a transport without an identity sends neither', async () => {
    await call(transport(null), path);
    const [captured] = panel.captured;
    expect(linesNamed(captured!, 'x-reiwa-client')).toEqual([]);
    expect(linesNamed(captured!, 'x-reiwa-capabilities')).toEqual([]);
  });

  it('changes nothing else: the same lines, the same body, a signature that verifies', async () => {
    const extra = { Range: 'bytes=0-9' };
    await call(transport(IDENTITY, 'shared'), path, extra);
    await call(transport(null, 'shared'), path, extra);
    const [identified, silent] = panel.captured;
    const ignored = new Set(['x-reiwa-client', 'x-reiwa-capabilities', 'x-request-timestamp', 'x-request-signature']);
    const lines = (captured: Captured): string[][] => {
      const kept: string[][] = [];
      for (let index = 0; index < captured.rawHeaders.length; index += 2) {
        const name = captured.rawHeaders[index]!;
        if (!ignored.has(name.toLowerCase())) kept.push([name, captured.rawHeaders[index + 1]!]);
      }
      return kept;
    };
    expect(lines(identified!)).toEqual(lines(silent!));
    expect(identified!.method).toBe(silent!.method);
    expect(identified!.url).toBe(silent!.url);
    expect(identified!.body).toBe(silent!.body);
    // The HMAC covers method, path and body only; the headers do not break it.
    const signed = verifyInternalSignature({
      secret: 'shared',
      method: identified!.method,
      path: identified!.url,
      body: identified!.body,
      timestamp: identified!.headers['x-request-timestamp'] as string,
      signature: identified!.headers['x-request-signature'] as string,
    });
    expect(signed).toBe(true);
  });
});

describe('an identity no header could carry as it is', () => {
  it('still makes a valid request, with each value reduced to safe characters', async () => {
    // undici refuses a header value with a control or non-ASCII character
    // (`UND_ERR_INVALID_ARG`) — for the WHOLE call. A Windows machine named in
    // Cyrillic, or a version with a stray newline, must not cost every call.
    const hostile: ReiwaClientIdentity = {
      surface: 'bot',
      version: '0.9.7.54\r\nx-injected: 1',
      commit: ';=,',
      instance: 'ПК-Дизайн',
      capabilities: ['bot.stale-button-menu', 'Bot.Upper', 'bot.x\r\ny', 'web.' + 'a'.repeat(60)],
    };
    await transport(hostile).request('GET', '/api/internal/test');
    const [captured] = panel.captured;
    expect(linesNamed(captured!, 'x-injected')).toEqual([]);
    const [client] = linesNamed(captured!, 'x-reiwa-client');
    // A value left with no letter or digit reads `unknown`, never an empty key.
    expect(client).toBe('surface=bot; version=0.9.7.54_x-injected_1; commit=unknown; instance=unknown');
    expect(linesNamed(captured!, 'x-reiwa-capabilities')).toEqual(['bot.stale-button-menu']);
  });

  it('never exceeds what the panel reads of x-reiwa-client, and keeps its four keys', async () => {
    const long: ReiwaClientIdentity = {
      surface: 'worker',
      version: '9'.repeat(500),
      commit: 'f'.repeat(500),
      instance: 'h'.repeat(500),
      capabilities: [],
    };
    await transport(long).request('GET', '/api/internal/test');
    const [client] = linesNamed(panel.captured[0]!, 'x-reiwa-client');
    expect(client!.length).toBeLessThanOrEqual(CLIENT_HEADER_MAX_LENGTH);
    expect(client!.split('; ').map((pair) => pair.split('=')[0])).toEqual(['surface', 'version', 'commit', 'instance']);
    // The worker declares nothing, and says so: an empty list, not silence.
    expect(linesNamed(panel.captured[0]!, 'x-reiwa-capabilities')).toEqual(['']);
  });

  it('the running build is what goes out for a real identity', async () => {
    const running: ReiwaClientIdentity = {
      surface: 'api',
      version: REIWA_BUILD_INFO.version,
      commit: REIWA_BUILD_INFO.commit,
      instance: 'reiwa',
      capabilities: [],
    };
    await transport(running).request('GET', '/api/internal/test');
    const [client] = linesNamed(panel.captured[0]!, 'x-reiwa-client');
    expect(client).toContain(`version=${REIWA_BUILD_INFO.version};`);
  });
});
