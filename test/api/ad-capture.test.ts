/**
 * Advertising capture on the web surface.
 *
 * The bug these cover: an ad link (`/?campaign=ad_<code>`) was only ever read by
 * the SPA, after authentication, straight off `window.location.search` — and the
 * entry page replaces the URL without its query before any session exists. The
 * code was gone before anything could report it, so the cabinet showed zero for
 * every web placement. Capture now happens on the document request, server-side.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

// Vitest's runner, not `node:test`: `npm test` executes these files through
// vitest, which reports a `node:test` module as "no tests" and still exits 0 —
// so assertions written against that runner never gate CI (14 of the
// auth-route tests are red today for exactly this reason).
import { afterAll, beforeAll, describe, it } from 'vitest';

import cookieParser from 'cookie-parser';
import express from 'express';

import type { AdminClient } from '../../src/lib/admin-client.js';
import {
  AD_CODE_COOKIE,
  AD_CODE_TTL_MS,
  createAdCaptureMiddleware,
} from '../../src/api/middleware/ad-capture.js';

interface Response {
  readonly status: number;
  readonly location: string | undefined;
  readonly setCookie: readonly string[];
  readonly cacheControl: string | undefined;
  readonly body: string;
}

function createAdminClientStub() {
  const calls: Record<string, unknown>[] = [];
  const client = {
    advertising: {
      recordClick: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { ok: true };
      },
    },
  } as unknown as AdminClient;
  return { calls, client };
}

function buildApp(adminClient: AdminClient | null): express.Express {
  const app = express();
  app.use(cookieParser());
  app.use(createAdCaptureMiddleware({ adminClient, cookieSecure: false }));
  // Terminal handler stands in for the static SPA / API routers below the
  // middleware: reaching it means the request was passed through untouched.
  app.use((_req, res) => {
    res.status(200).send('passthrough');
  });
  return app;
}

/**
 * ONE listening server for the whole file, dispatching to whichever app the
 * current test installed.
 *
 * A server per request churned through ephemeral ports and left sockets closing
 * behind each test; under a full-suite run that intermittently killed the vitest
 * fork and took unrelated files down with it (the files were always green in
 * isolation). Keep-alive is off so every socket ends deterministically.
 */
let sharedServer: http.Server | undefined;
let sharedPort = 0;
let currentApp: express.Express | undefined;

beforeAll(async () => {
  sharedServer = http.createServer((req, res) => {
    if (currentApp === undefined) {
      res.statusCode = 500;
      res.end('no app installed');
      return;
    }
    currentApp(req, res);
  });

  sharedServer.on('clientError', (_err, socket) => socket.destroy());
  // Note this does NOT shorten anything: 0 *disables* the keep-alive timeout.
  // What actually ends every socket here is the client's `Connection: close`
  // below; this line only keeps Node from reaping a socket mid-assertion.
  sharedServer.keepAliveTimeout = 0;
  // A listen failure must surface as itself. Swallowing it left the promise
  // below unsettled, so an EMFILE — the very exhaustion this shared server
  // exists to relieve — reported as "beforeAll timed out" with no errno.
  await new Promise<void>((resolve, reject) => {
    sharedServer!.once('error', reject);
    sharedServer!.listen(0, '127.0.0.1', () => {
      sharedServer!.removeListener('error', reject);
      sharedServer!.on('error', () => undefined);
      resolve();
    });
  });
  sharedPort = (sharedServer!.address() as { port: number }).port;
});

afterAll(async () => {
  const server = sharedServer;
  sharedServer = undefined;
  if (server === undefined) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(
  app: express.Express,
  path: string,
  options: { method?: string; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  currentApp = app;
  return new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: sharedPort,
        path,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
          ...(options.headers ?? {}),
          // Last, so a caller cannot clobber it: this header — not
          // `keepAliveTimeout` — is what ends each socket, and the shared
          // server depends on that.
          Connection: 'close',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('error', () => undefined);
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = response.headers['set-cookie'];
          resolve({
            status: response.statusCode ?? 500,
            location:
              typeof response.headers.location === 'string' ? response.headers.location : undefined,
            setCookie: Array.isArray(raw) ? raw : raw === undefined ? [] : [raw],
            cacheControl:
              typeof response.headers['cache-control'] === 'string'
                ? response.headers['cache-control']
                : undefined,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('advertising capture middleware', () => {
  it('counts the open, parks the code and strips only the ad param', async () => {
    const admin = createAdminClientStub();
    const response = await request(
      buildApp(admin.client),
      '/?campaign=ad_WIcpYLNTs5&utm_source=tg&ref=friend',
    );

    // The open is counted while the visitor is still anonymous — that is the
    // "переход по объявлению" the cabinet reports — and it carries the UTM tags
    // that came with it.
    assert.deepEqual(admin.calls, [{ code: 'WIcpYLNTs5', surface: 'WEB', utmSource: 'tg' }]);

    const cookie = response.setCookie.find((value) => value.startsWith(`${AD_CODE_COOKIE}=`));
    assert.ok(cookie !== undefined, 'the code must survive until registration');
    assert.match(cookie, /^ad_code=WIcpYLNTs5;/);
    assert.match(cookie, /HttpOnly/);
    // Attributes are the contract, not decoration: a missing Max-Age makes the
    // cookie session-scoped (lost on browser restart) and a narrowed Path makes
    // it invisible to POST /api/v1/auth/register.
    assert.match(cookie, new RegExp(`Max-Age=${Math.floor(AD_CODE_TTL_MS / 1000)}\\b`));
    assert.match(cookie, /Path=\/(;|$)/);
    assert.match(cookie, /SameSite=Lax/i);
    // A cached 302 would freeze both the ingest and the cookie for everyone
    // behind the cache.
    assert.match(String(response.cacheControl), /no-store/);

    // Redirecting without the ad param keeps the code out of the SPA entirely,
    // so a navigation that drops the query can no longer lose attribution.
    assert.equal(response.status, 302);
    assert.equal(response.location, '/?utm_source=tg&ref=friend');
  });

  it('does not re-count an open for a browser that already carries the code', async () => {
    const admin = createAdminClientStub();
    const response = await request(buildApp(admin.client), '/?campaign=ad_WIcpYLNTs5', {
      cookie: 'ad_code=WIcpYLNTs5',
    });
    assert.deepEqual(admin.calls, []);
    assert.equal(response.status, 302);
    assert.equal(response.location, '/');
  });

  it('counts a new open when the browser arrives from a different placement', async () => {
    const admin = createAdminClientStub();
    await request(buildApp(admin.client), '/?campaign=ad_OTHERCODE', {
      cookie: 'ad_code=WIcpYLNTs5',
    });
    assert.deepEqual(admin.calls, [{ code: 'OTHERCODE', surface: 'WEB' }]);
  });

  it('passes through a malformed campaign param without redirecting', async () => {
    const admin = createAdminClientStub();
    const response = await request(buildApp(admin.client), '/?campaign=not-an-ad-code');
    assert.deepEqual(admin.calls, []);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'passthrough');
    assert.equal(response.setCookie.length, 0);
  });

  it('never touches API requests or non-GET methods', async () => {
    const admin = createAdminClientStub();
    const api = await request(buildApp(admin.client), '/api/v1/session?campaign=ad_WIcpYLNTs5');
    assert.equal(api.status, 200);
    assert.equal(api.location, undefined);

    const post = await request(buildApp(admin.client), '/?campaign=ad_WIcpYLNTs5', {
      method: 'POST',
    });
    assert.equal(post.status, 200);
    assert.equal(post.location, undefined);

    assert.deepEqual(admin.calls, []);
  });

  it('keeps the strip-redirect same-origin for a protocol-relative path', async () => {
    const admin = createAdminClientStub();
    const response = await request(buildApp(admin.client), '//evil.example/?campaign=ad_WIcpYLNTs5');
    assert.equal(response.status, 302);
    assert.ok(
      response.location !== undefined && !response.location.startsWith('//'),
      `redirect must not be protocol-relative, got ${String(response.location)}`,
    );
    assert.equal(response.location, '/evil.example/');
  });

  it('forwards the UTM tags that arrived on the landing URL', async () => {
    // The cabinet has always had a UTM breakdown that could only be empty: nothing
    // read the tags off the landing URL, so no click ever carried them. This is
    // what the very first bug report about "фиксация utm-меток" described.
    const admin = createAdminClientStub();
    const response = await request(
      buildApp(admin.client),
      '/?campaign=ad_WIcpYLNTs5&utm_source=vk&utm_medium=cpc&utm_campaign=july&utm_term=banner2',
    );
    assert.deepEqual(admin.calls, [
      {
        code: 'WIcpYLNTs5',
        surface: 'WEB',
        utmSource: 'vk',
        utmMedium: 'cpc',
        utmCampaign: 'july',
        // utm_term is what VK and Yandex emit; the reports call it the creative.
        utmCreative: 'banner2',
      },
    ]);
    // The tags stay in the URL for the register form's snapshot.
    assert.equal(
      response.location,
      '/?utm_source=vk&utm_medium=cpc&utm_campaign=july&utm_term=banner2',
    );
  });

  it('ignores sub-resource requests — an <img> must not stuff a cookie or an open', async () => {
    // Without this gate `<img src="https://cabinet/favicon.ico?campaign=ad_X">` on
    // any third-party page counts an open and plants a 7-day attribution cookie,
    // which pays partner commission on the visitor's next organic signup.
    const admin = createAdminClientStub();
    for (const dest of ['image', 'script', 'iframe', 'empty']) {
      const response = await request(buildApp(admin.client), '/favicon.ico?campaign=ad_WIcpYLNTs5', {
        headers: { 'sec-fetch-dest': dest },
      });
      assert.equal(response.status, 200, `dest=${dest} must pass through`);
      assert.equal(response.location, undefined);
      assert.equal(response.setCookie.length, 0, `dest=${dest} must not set a cookie`);
    }
    assert.deepEqual(admin.calls, []);
  });

  it('ignores prefetch/prerender and HEAD — neither is a person arriving from an ad', async () => {
    const admin = createAdminClientStub();
    const prefetch = await request(buildApp(admin.client), '/?campaign=ad_WIcpYLNTs5', {
      headers: { 'sec-purpose': 'prefetch;prerender' },
    });
    assert.equal(prefetch.status, 200);
    assert.equal(prefetch.setCookie.length, 0);

    const head = await request(buildApp(admin.client), '/?campaign=ad_WIcpYLNTs5', {
      method: 'HEAD',
    });
    assert.equal(head.status, 200);
    assert.equal(head.location, undefined);

    assert.deepEqual(admin.calls, []);
  });

  it('counts one open and strips both keys when campaign and startapp are present', async () => {
    // Leaving the unmatched key on the redirect target made the next hop count a
    // second open and overwrite the cookie — one visitor, two clicks, attribution
    // credited to the wrong placement.
    const admin = createAdminClientStub();
    const response = await request(
      buildApp(admin.client),
      '/?campaign=ad_WIcpYLNTs5&startapp=ad_OTHERCODE&utm_source=tg',
    );
    assert.deepEqual(admin.calls, [{ code: 'WIcpYLNTs5', surface: 'WEB', utmSource: 'tg' }]);
    assert.equal(response.location, '/?utm_source=tg');
  });

  it('survives a repeated campaign key (Express hands over an array)', async () => {
    const admin = createAdminClientStub();
    const response = await request(
      buildApp(admin.client),
      '/?campaign=not-an-ad-code&campaign=ad_WIcpYLNTs5',
    );
    assert.deepEqual(admin.calls, [{ code: 'WIcpYLNTs5', surface: 'WEB' }]);
    assert.equal(response.status, 302);
    assert.equal(response.location, '/');
  });

  it('takes the tracking code from the startapp key too', async () => {
    const admin = createAdminClientStub();
    const response = await request(buildApp(admin.client), '/?startapp=ad_WIcpYLNTs5');
    assert.deepEqual(admin.calls, [{ code: 'WIcpYLNTs5', surface: 'WEB' }]);
    assert.equal(response.location, '/');
  });

  it('overwrites the parked code when a later ad link wins the visitor', async () => {
    const admin = createAdminClientStub();
    const response = await request(buildApp(admin.client), '/?campaign=ad_OTHERCODE', {
      cookie: 'ad_code=WIcpYLNTs5',
    });
    const cookie = response.setCookie.find((value) => value.startsWith(`${AD_CODE_COOKIE}=`));
    assert.ok(cookie !== undefined);
    assert.match(cookie, /^ad_code=OTHERCODE;/);
  });

  it('keeps an absolute-form request target same-origin', async () => {
    // `GET https://evil.example/x?...` leaves the host in req.originalUrl but not
    // in req.path, so the target must be rebuilt from the parsed path.
    const admin = createAdminClientStub();
    const response = await request(
      buildApp(admin.client),
      'https://evil.example/x?campaign=ad_WIcpYLNTs5',
    );
    assert.equal(response.status, 302);
    assert.equal(response.location, '/x');
  });

  it('still parks the code when rezeis is unreachable', async () => {
    const response = await request(buildApp(null), '/?campaign=ad_WIcpYLNTs5');
    assert.equal(response.status, 302);
    assert.ok(
      response.setCookie.some((value) => value.startsWith('ad_code=WIcpYLNTs5;')),
      'registration can still claim attribution once rezeis is back',
    );
  });
});
