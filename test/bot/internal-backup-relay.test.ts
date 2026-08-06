/**
 * `/notify-backup-document` — the bot end of the backup relay.
 *
 * On the split deployment the bot token lives here, not in rezeis, so THIS is
 * the production delivery path for every backup: rezeis hands over a signed
 * download token, the bot pulls the file and uploads it to Telegram itself.
 *
 * Because the fetch + upload happen after the HTTP hop is accepted, a 2xx on
 * its own proves nothing about the file. Telegram's message id, echoed back
 * through reiwa, is the only evidence in the exchange — and rezeis stamps a
 * backup as delivered off-site strictly on a numeric `messageId`, treating any
 * other 2xx as `unconfirmed`, which it deliberately does not retry.
 *
 * These tests drive the real listener over a real socket (signed with the real
 * internal HMAC) so they cover the routing and auth a production call goes
 * through, not just the handler body.
 */
import http from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';
import {
  BACKUP_RELAY_CONTRACT,
  startInternalHttpListener,
} from '../../src/bot/listeners/internal-http-listener.js';

const SECRET = 's'.repeat(32);
const REZEIS_ADMIN_URL = 'http://rezeis:8000';
const PATH = '/notify-backup-document';

/**
 * The statuses rezeis's `isTransientHttpStatus`
 * (`rezeis-admin/src/modules/backup/backup-delivery-retry.util.ts`) calls
 * temporary — `status >= 500 || status === 408 || status === 429` — spelled out
 * as literals on purpose. Deriving them from reiwa's copy of the rule would let
 * the copy drift and still agree with itself; written out, a change to the rule
 * has to be made here too and argued for.
 */
const TRANSIENT_DOWNLOAD_STATUSES = [408, 429, 500, 502, 503, 504, 507, 599] as const;
/** A representative sweep of the statuses it does NOT call temporary. */
const PERMANENT_DOWNLOAD_STATUSES = [400, 401, 403, 404, 409, 410, 422, 499] as const;

/** A real undici network failure, shape and all — what a dead hop throws. */
function networkFailure(): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

const BACKUP_BODY = {
  recordId: 'ckbackup0001',
  token: 'signed-download-token',
  chatId: '-1001234567890',
  filename: 'reiwa-2026-08-06.sql.gz',
  caption: 'Backup',
  topicThreadId: 42,
};

interface RelayResult {
  readonly status: number;
  readonly text: string;
  readonly contentType: string | undefined;
  /** Arguments `bot.api.sendDocument` was called with, one entry per call. */
  readonly sendCalls: readonly (readonly unknown[])[];
  /** The rezeis download URL the bot fetched, or `null` if it never got there. */
  readonly downloadUrl: string | null;
}

/**
 * Boot the real listener on an ephemeral port with a stubbed bot and a stubbed
 * rezeis download, POST one backup relay at it, and return the raw response
 * plus what the bot actually did. `sendDocument` is supplied by the caller so a
 * test can pick the Telegram outcome it wants to pin. `sign: false` omits the
 * HMAC headers.
 */
async function callBackupRelay(opts: {
  readonly sendDocument?: () => Promise<unknown>;
  readonly downloadStatus?: number;
  /** Make the download `fetch` REJECT — no HTTP exchange completes at all. */
  readonly downloadError?: Error;
  /** Answer the download 2xx with a null `body` (rezeis said 204 No Content). */
  readonly downloadBodyless?: boolean;
  readonly sign?: boolean;
}): Promise<RelayResult> {
  const sendDocument = vi.fn(opts.sendDocument ?? (async () => ({ message_id: 1 })));
  const bot = { api: { sendDocument } } as unknown as ListenerOptions['bot'];
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  if (opts.downloadError !== undefined) {
    fetchMock.mockRejectedValue(opts.downloadError);
  } else if (opts.downloadBodyless === true) {
    // 204 is the success status the fetch spec gives a null `body`.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  } else {
    fetchMock.mockResolvedValue(
      new Response('backup-bytes', { status: opts.downloadStatus ?? 200 }),
    );
  }

  const server = startInternalHttpListener({
    bot,
    cache: null,
    secret: SECRET,
    port: 0,
    logger: silentLogger,
    rezeisAdminUrl: REZEIS_ADMIN_URL,
  });
  if (server === null) throw new Error('listener did not start');

  try {
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    const raw = JSON.stringify(BACKUP_BODY);
    const authHeaders: Record<string, string> = {};
    if (opts.sign !== false) {
      const { timestamp, signature } = buildInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: PATH,
        body: raw,
      });
      authHeaders[REQUEST_TIMESTAMP_HEADER] = timestamp;
      authHeaders[REQUEST_SIGNATURE_HEADER] = signature;
    }

    // node:http, not fetch — `fetch` is mocked out for the rezeis download.
    // `agent: false` + `connection: close` keep the socket from lingering, so
    // `server.close()` below settles deterministically.
    const response = await new Promise<{
      status: number;
      text: string;
      contentType: string | undefined;
    }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: PATH,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            connection: 'close',
            ...authHeaders,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text,
              contentType: res.headers['content-type'],
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(raw);
    });

    const firstFetch = fetchMock.mock.calls[0]?.[0];
    return {
      ...response,
      sendCalls: sendDocument.mock.calls as unknown as readonly (readonly unknown[])[],
      downloadUrl: firstFetch === undefined ? null : String(firstFetch),
    };
  } finally {
    fetchMock.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('bot /notify-backup-document', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the Telegram message id after a successful upload', async () => {
    const { status, text, contentType, sendCalls } = await callBackupRelay({
      sendDocument: async () => ({ message_id: 8899 }),
    });

    expect(sendCalls).toHaveLength(1);
    // 200 + a numeric messageId is exactly what rezeis requires before it
    // records a backup as delivered off-site. A bare 204 here — what this
    // endpoint used to answer on success — is filed as `unconfirmed` instead,
    // alerting the operator about a backup that in fact reached Telegram.
    expect(status).toBe(200);
    expect(contentType).toContain('application/json');
    expect(JSON.parse(text)).toEqual({ messageId: 8899 });
  });

  it('still uploads to the same chat, topic and caption', async () => {
    // Guards against the fix being satisfied by a handler that answers with an
    // id while quietly changing what it actually sends.
    const { downloadUrl, sendCalls } = await callBackupRelay({
      sendDocument: async () => ({ message_id: 8899 }),
    });

    expect(downloadUrl).toContain('/api/internal/backups/download');
    expect(downloadUrl).toContain('recordId=ckbackup0001');
    expect(downloadUrl).toContain('token=signed-download-token');
    const [chatId, , options] = sendCalls[0] as [string, unknown, Record<string, unknown>];
    expect(chatId).toBe('-1001234567890');
    expect(options).toMatchObject({ caption: 'Backup', message_thread_id: 42 });
  });

  it('does not fake an id when the upload fails', async () => {
    // The file never reached Telegram. Answering 200 with any id would stamp a
    // local-only backup as safely off-site — and retention prunes local copies
    // it believes Telegram is holding.
    const { status, text, sendCalls } = await callBackupRelay({
      sendDocument: async () => {
        throw new Error('Bad Request: chat not found');
      },
    });

    expect(sendCalls).toHaveLength(1);
    expect(status).toBe(204);
    expect(text).toBe('');
  });

  it('does not fake an id when the backup could not be downloaded', async () => {
    const { status, text, sendCalls } = await callBackupRelay({
      sendDocument: async () => ({ message_id: 8899 }),
      downloadStatus: 404,
    });

    // Nothing was uploaded, so nothing may be reported as delivered.
    expect(sendCalls).toHaveLength(0);
    expect(status).toBe(204);
    expect(text).toBe('');
  });

  // ── Which download failures are worth another attempt ──────────────────────
  //
  // "Could not download" is three different events, and answering all of them
  // 204 spends rezeis's only lever — `unconfirmed` is deliberately NOT retried —
  // on failures that a retry seconds later would sail through. Nothing is
  // uploaded in any of them, so unlike the post-`sendDocument` paths a retry
  // here cannot put a second multi-gigabyte file in the operator's topic.

  it('matches rezeis on exactly which statuses are worth another attempt', () => {
    const { isTransientDownloadStatus, retryableStatus } = BACKUP_RELAY_CONTRACT;

    for (const status of TRANSIENT_DOWNLOAD_STATUSES) {
      expect(isTransientDownloadStatus(status), `${status} must be transient`).toBe(true);
    }
    for (const status of PERMANENT_DOWNLOAD_STATUSES) {
      expect(isTransientDownloadStatus(status), `${status} must be permanent`).toBe(false);
    }
    // Closes the loop across the hop. The status we answer in order to REQUEST a
    // retry is the only value that actually crosses to rezeis, and rezeis feeds
    // it to its own copy of this rule. So the rule must call our own answer
    // temporary — narrow it to exclude 5xx and the status stops meaning the
    // thing it is answered for, which fails right here instead of silently
    // burying a backup on the far side.
    expect(isTransientDownloadStatus(retryableStatus)).toBe(true);
    // …and the "do not retry" answer must not be, or both branches below would
    // be asking rezeis for the same thing.
    expect(isTransientDownloadStatus(204)).toBe(false);
  });

  it('asks rezeis to retry when rezeis answered the download transiently', async () => {
    for (const downloadStatus of TRANSIENT_DOWNLOAD_STATUSES) {
      const label = `download ${downloadStatus}`;
      const { status, text, sendCalls, downloadUrl } = await callBackupRelay({ downloadStatus });

      // Self-check: the handler must actually have reached the download. Without
      // this, any earlier bail-out that happened to answer the same code would
      // satisfy the assertion below for free.
      expect(downloadUrl, label).toContain('/api/internal/backups/download');
      expect(sendCalls, label).toHaveLength(0);
      // A 204 here is filed by rezeis as `unconfirmed` and never retried, so a
      // rezeis restart permanently loses that night's off-site copy.
      expect(status, label).toBe(BACKUP_RELAY_CONTRACT.retryableStatus);
      expect(text, label).toBe('');
    }
  });

  it('leaves a permanent download refusal non-retryable', async () => {
    // A spent or forged token, a record that no longer exists: rezeis refuses an
    // identical retry identically, so three attempts buy nothing but a delay on
    // alerting the operator.
    for (const downloadStatus of PERMANENT_DOWNLOAD_STATUSES) {
      const label = `download ${downloadStatus}`;
      const { status, sendCalls, downloadUrl } = await callBackupRelay({ downloadStatus });

      expect(downloadUrl, label).toContain('/api/internal/backups/download');
      expect(sendCalls, label).toHaveLength(0);
      expect(status, label).toBe(204);
    }
  });

  it('asks rezeis to retry when the download never reached rezeis at all', async () => {
    // `fetch` threw: no HTTP exchange completed, so this is the one failure we
    // can be certain never touched Telegram — the cheapest retry of the set.
    const { status, text, sendCalls, downloadUrl } = await callBackupRelay({
      downloadError: networkFailure(),
    });

    expect(downloadUrl).toContain('/api/internal/backups/download');
    expect(sendCalls).toHaveLength(0);
    expect(status).toBe(BACKUP_RELAY_CONTRACT.retryableStatus);
    expect(text).toBe('');
  });

  it('does not retry when rezeis answered the download success-but-empty', async () => {
    // 2xx with a null body — rezeis said 204 No Content. Nothing was uploaded,
    // but unlike a 503 this is systematic, not a bad moment: an identical retry
    // earns an identically empty response, so it cannot change the answer.
    const { status, sendCalls, downloadUrl } = await callBackupRelay({ downloadBodyless: true });

    expect(downloadUrl).toContain('/api/internal/backups/download');
    expect(sendCalls).toHaveLength(0);
    expect(status).toBe(204);
  });

  it('keeps a network-shaped UPLOAD failure on 204 so a retry cannot duplicate the file', async () => {
    // The SAME error object as the download-never-reached-rezeis case above, on
    // the other side of `sendDocument` — and it must get the opposite answer.
    // Once the upload is entered the bytes may already be in the topic (a
    // mid-upload reset on a 2 GB file looks exactly like this), so asking for a
    // retry risks a second copy. The discriminator is not the error, it is
    // whether `sendDocument` ran, which `sendCalls` pins.
    const { status, text, sendCalls } = await callBackupRelay({
      sendDocument: async () => {
        throw networkFailure();
      },
    });

    expect(sendCalls).toHaveLength(1);
    expect(status).toBe(204);
    expect(text).toBe('');
  });

  it('reports unconfirmed rather than inventing an id when Telegram names none', async () => {
    // Send resolved but carried no id. A retry would upload a second copy of a
    // backup that is already there and still could not prove it, so this must
    // land on a 2xx-without-id (rezeis: `unconfirmed`, not retried) — never on
    // a made-up number and never on a retryable error.
    const { status, text, sendCalls } = await callBackupRelay({
      sendDocument: async () => ({}),
    });

    expect(sendCalls).toHaveLength(1);
    expect(status).toBe(204);
    expect(text).toBe('');
  });

  it('rejects an unsigned request', async () => {
    // The listener is reachable over the docker hop; the fix must not have
    // opened a path that hands message ids to unauthenticated callers.
    const { status, sendCalls } = await callBackupRelay({ sign: false });

    expect(status).toBe(401);
    expect(sendCalls).toHaveLength(0);
  });
});
