/**
 * The rezeis `/uploads/*` header policy, as it applies on the SUBSCRIBER-facing
 * origin.
 *
 * rezeis serves operator uploads with `express.static` and attaches three
 * headers in `applyUploadResponseHeaders` (rezeis/rezeis-admin/src/main.ts).
 * reiwa re-serves the same bytes through its own handlers, so those headers do
 * not travel with the file — they have to be set again here, on every relay,
 * including the branding disk mirror that keeps serving after the admin host
 * has gone away.
 *
 * ── WHAT THIS FILE CAN AND CANNOT SEE ───────────────────────────────────────
 * The literals pinned below are a MIRROR of a constant in a DIFFERENT
 * REPOSITORY, and they used to be nothing more than that: a rezeis-side edit
 * to the CSP string or to `MARKUP_UPLOAD_EXTENSIONS` left every test in this
 * file green while the two origins enforced different policies on the same
 * bytes — which for the `attachment` rule means an upload the panel forces
 * you to download is rendered inline here, in the subscriber's session.
 *
 * The cases in "the panel is the origin of this policy" close that, by READING
 * `rezeis/rezeis-admin/src/main.ts` as source text out of the sibling checkout
 * — the same move `test/web/card-effect-catalog-parity.test.ts` and
 * `test/web/branding-vocabulary-panel-parity.test.ts` already make, for the
 * same reason: no package is shared, so text is the only link there is.
 *
 * THE HOLE THAT USED TO LEAVE, and what now stands in it: reiwa's CI
 * (`.github/workflows/ci.yml`) runs `actions/checkout` on reiwa ALONE, so the
 * sibling checkout is absent there and every cross-repo case SKIPPED. The
 * guard was live on a developer machine holding both trees — which is where
 * the edit that would diverge them gets made — and dead in CI.
 *
 * The panel's half of the policy is therefore COMMITTED here, in
 * `test/support/panel-parity-manifest.ts`, and a SHA-256 of its canonical form
 * is written down below as `UPLOAD_POLICY_DIGEST` — and the identical literal
 * is written down in `rezeis-admin/test/reiwa-parity-digest.spec.ts`, which
 * computes it from the panel's LIVE source. Change the panel and that spec goes
 * red until someone writes a new digest, and its message names this file. The
 * cases below then run EVERYWHERE, against the committed copy.
 *
 * What that still cannot do, said plainly: if the panel changes, the rezeis
 * literal is updated, and reiwa is never touched, both pipelines stay green and
 * the two repositories hold different digests for one policy. No single-repo CI
 * job can see the other repository. What is bought is that the divergence takes
 * a deliberate edit to a constant whose failure message asked for this file by
 * name — instead of happening in silence.
 *
 * The sibling read survives as the LOCAL EXTRA it always was: when both trees
 * are present it says which extension differs, which a digest cannot. Only that
 * one case skips now, and its skip is honest — it is an additional check, not
 * the guard.
 */
import express from 'express';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createContentRouter } from '../../src/api/routes/content.js';
import {
  applyUploadRelayHeaders,
  MARKUP_UPLOAD_EXTENSIONS,
  UPLOAD_RELAY_CSP,
  UPLOAD_RELAY_MARKUP_DISPOSITION,
  UPLOAD_RELAY_NOSNIFF,
} from '../../src/api/lib/upload-relay-headers.js';
import {
  CANONICAL_FIXTURE,
  CANONICAL_FIXTURE_DIGEST,
  CANONICAL_FIXTURE_FORM,
  canonicalise,
  digestDriftMessage,
  digestOf,
  EMPTY_ARRAY_DIGEST,
  EMPTY_INPUT_DIGEST,
  EMPTY_OBJECT_DIGEST,
  UPLOAD_POLICY_SURFACE,
} from '../support/panel-parity-digest.js';
import { PANEL_UPLOAD_POLICY } from '../support/panel-parity-manifest.js';

// The branding cache is a process-wide singleton, constructed on the FIRST
// `createApp` call and reading its directory from the environment right there.
// Nothing above calls `createApp`, so setting the variable here — module body,
// before any test runs — is early enough to own the mirror directory.
const previousCacheDir = process.env['BRANDING_CACHE_DIR'];
const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'reiwa-branding-cache-'));
process.env['BRANDING_CACHE_DIR'] = cacheDir;

/**
 * THE POLICY, WRITTEN OUT — the answer, before anything is compared to
 * anything. Both the panel's list and this relay's copy are checked against
 * THIS, in that order, and never against each other: an agreement-only
 * assertion between two implementations is green on the day both are wrong,
 * which is precisely how a mirror drifts.
 */
const EXPECTED_MARKUP_EXTENSIONS = [
  '.svg',
  '.svgz',
  '.xml',
  '.xhtml',
  '.html',
  '.htm',
  '.xht',
] as const;

const EXPECTED_CSP = "default-src 'none'; sandbox";
const EXPECTED_NOSNIFF = 'nosniff';
const EXPECTED_MARKUP_DISPOSITION = 'attachment';

/**
 * Every header the panel's `applyUploadResponseHeaders` sets, by name, sorted.
 *
 * `markupOnly` records whether the call sits inside the extension branch, and
 * it is load-bearing: moving `Content-Security-Policy` into that branch would
 * leave the NAME and the VALUE untouched while silently unsandboxing every
 * raster upload on both origins. A name-to-value map alone would not notice.
 */
const EXPECTED_PANEL_HEADERS = [
  { name: 'Content-Disposition', value: EXPECTED_MARKUP_DISPOSITION, markupOnly: true },
  { name: 'Content-Security-Policy', value: EXPECTED_CSP, markupOnly: false },
  { name: 'X-Content-Type-Options', value: EXPECTED_NOSNIFF, markupOnly: false },
] as const;

/**
 * SHA-256 of the canonical form of `PANEL_UPLOAD_POLICY`.
 *
 * WRITTEN DOWN FIRST, and identical to `UPLOAD_POLICY_DIGEST` in
 * `rezeis-admin/test/reiwa-parity-digest.spec.ts`, which computes the same
 * number from the panel's LIVE `src/main.ts`. Two repositories, one literal,
 * neither able to read the other — so each is pinned to the answer rather than
 * to its counterpart, and the counterpart cannot move without its own CI
 * demanding a new literal and naming this file in the message.
 *
 * Changing this line is a two-repository change. See `digestDriftMessage`.
 */
const UPLOAD_POLICY_DIGEST =
  '5867b819cfbca6d974151cfd1a2d2ee1dfd3bb81b49927e7537e1941c26ff958';

// ── Reading the panel ───────────────────────────────────────────────────────

/** The sibling checkout itself: `<workspace>/rezeis/rezeis-admin/`. */
const PANEL_REPO_URL = new URL('../../../rezeis/rezeis-admin/', import.meta.url);
const PANEL_MAIN_URL = new URL('src/main.ts', PANEL_REPO_URL);
const PANEL_REPO_PATH = fileURLToPath(PANEL_REPO_URL);
const PANEL_MAIN_PATH = fileURLToPath(PANEL_MAIN_URL);

/** The two names this reader is looking for, so a mutation has one place to hit. */
const PANEL_EXTENSIONS_NAME = 'MARKUP_UPLOAD_EXTENSIONS';
const PANEL_HELPER_NAME = 'applyUploadResponseHeaders';

interface PanelHeader {
  readonly name: string;
  readonly value: string;
  /** The call is inside the markup `if`, so it does not apply to every upload. */
  readonly markupOnly: boolean;
}

interface PanelPolicy {
  /** `MARKUP_UPLOAD_EXTENSIONS`, in declaration order. */
  readonly extensions: readonly string[];
  /** Every `res.setHeader(...)` in the helper, sorted by header name. */
  readonly headers: readonly PanelHeader[];
}

/** Strip `satisfies` / `as` / parentheses to reach the literal underneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringOf(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  const value = unwrap(node);
  return ts.isStringLiteralLike(value) ? value.text : null;
}

/**
 * Read the panel's policy out of `main.ts` with the TypeScript parser rather
 * than a regular expression.
 *
 * A regex here is not merely fragile, it is fragile in the ONE direction that
 * matters: the declaration reads `const MARKUP_UPLOAD_EXTENSIONS: readonly
 * string[] = [`, so the obvious `NAME[^[]*\[([^\]]*)\]` stops at the bracket
 * pair in `string[]` and extracts NOTHING — a guard that silently matches zero
 * extensions and then passes forever. The AST sees what the compiler sees, and
 * the non-vacuity case below fails outright if it ever sees nothing.
 *
 * Returns `null` when either name is gone, which is a finding, not an absence.
 */
function readPanelPolicy(): PanelPolicy | null {
  const source = ts.createSourceFile(
    PANEL_MAIN_PATH,
    readFileSync(PANEL_MAIN_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  let extensions: string[] | null = null;
  let headers: PanelHeader[] | null = null;

  const collectHeaders = (node: ts.Node, withinIf: boolean, into: PanelHeader[]): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setHeader'
    ) {
      const name = stringOf(node.arguments[0]);
      const value = stringOf(node.arguments[1]);
      // A non-literal argument is recorded as such rather than dropped: a
      // dropped call is invisible, and invisible is what this file is for.
      into.push({
        name: name ?? '<non-literal header name>',
        value: value ?? '<non-literal header value>',
        markupOnly: withinIf,
      });
    }
    ts.forEachChild(node, (child) =>
      collectHeaders(child, withinIf || ts.isIfStatement(node), into),
    );
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === PANEL_EXTENSIONS_NAME
    ) {
      const initializer = node.initializer === undefined ? undefined : unwrap(node.initializer);
      extensions =
        initializer !== undefined && ts.isArrayLiteralExpression(initializer)
          ? initializer.elements.map((element) => stringOf(element) ?? '<non-literal>')
          : [];
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === PANEL_HELPER_NAME) {
      const found: PanelHeader[] = [];
      if (node.body !== undefined) collectHeaders(node.body, false, found);
      headers = found;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  if (extensions === null || headers === null) return null;
  return {
    extensions,
    headers: [...(headers as PanelHeader[])].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Only meaningful on a machine holding both checkouts side by side. reiwa's CI
 * clones reiwa alone, so there these cases skip — see the note at the top.
 *
 * The skip is allowed ONLY when the whole sibling repository is absent. If the
 * repo is there and `src/main.ts` is not, the file moved, and the always-running
 * case below turns that into a red test instead of a skip that would go on
 * reporting "skipped" for as long as it took anyone to notice.
 */
const hasSiblingRepo = existsSync(PANEL_REPO_PATH);
const hasPanelSource = existsSync(PANEL_MAIN_PATH);

const CONFIG = {
  NODE_ENV: 'test',
  REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1',
  REZEIS_HOST: 'rezeis-admin',
  REZEIS_PORT: 8000,
} as never;

interface Captured {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

async function get(
  handler: express.Express,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<Captured> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<Captured>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** An upstream rezeis response for the icons / emoji / branding relays. */
function upstream(body: string, contentType: string): Response {
  return new Response(Buffer.from(body), { status: 200, headers: { 'content-type': contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (previousCacheDir === undefined) delete process.env['BRANDING_CACHE_DIR'];
  else process.env['BRANDING_CACHE_DIR'] = previousCacheDir;
  await rm(cacheDir, { recursive: true, force: true });
});

describe('rezeis /uploads relay — mirrored policy constants', () => {
  it('pins the three header values copied from rezeis applyUploadResponseHeaders', () => {
    expect(UPLOAD_RELAY_CSP).toBe("default-src 'none'; sandbox");
    expect(UPLOAD_RELAY_NOSNIFF).toBe('nosniff');
    expect(UPLOAD_RELAY_MARKUP_DISPOSITION).toBe('attachment');
  });

  it('pins the exact markup extension list copied from rezeis MARKUP_UPLOAD_EXTENSIONS', () => {
    // Non-emptiness anchor first, so an emptied list cannot pass by vacuity …
    expect(MARKUP_UPLOAD_EXTENSIONS.length).toBeGreaterThan(0);
    // … then the direction-complete assertion: this exact list, in this order,
    // and nothing else.
    expect([...MARKUP_UPLOAD_EXTENSIONS]).toEqual([
      '.svg',
      '.svgz',
      '.xml',
      '.xhtml',
      '.html',
      '.htm',
      '.xht',
    ]);
  });
});

describe('rezeis /uploads relay — the helper, on a bare response', () => {
  /**
   * These two exist because the route-level tests below CANNOT see one of the
   * three headers on their own. `createApp` mounts helmet app-wide, and helmet
   * sets `X-Content-Type-Options: nosniff` on every response — so deleting the
   * nosniff line from `applyUploadRelayHeaders` leaves every `/uploads/*` route
   * assertion green. (Verified by mutation, not assumed.) The CSP and
   * `Content-Disposition` assertions down there are sensitive — helmet sets a
   * DIFFERENT CSP and no disposition at all — but nosniff needs a response with
   * no helmet in front of it, which is what these two provide.
   */
  function sink(): { headers: Record<string, string>; setHeader(n: string, v: string): void } {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    };
  }

  it('sets all three headers on a markup upload', () => {
    const res = sink();
    applyUploadRelayHeaders(res, 'operator-logo.svg');
    expect(res.headers).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'attachment',
    });
  });

  it('sets CSP and nosniff but never a disposition on a raster upload', () => {
    const res = sink();
    applyUploadRelayHeaders(res, 'operator-logo.png');
    expect(res.headers).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  it.each(['.svg', '.svgz', '.xml', '.xhtml', '.html', '.htm', '.xht'])(
    'forces a download for every markup extension: %s',
    (extension) => {
      const res = sink();
      applyUploadRelayHeaders(res, `operator-upload${extension}`);
      expect(res.headers['Content-Disposition']).toBe('attachment');
    },
  );

  it.each(['.png', '.webp', '.jpg', '.jpeg', '.json', '.mp4', '.gif'])(
    'leaves a non-markup upload inline: %s',
    (extension) => {
      const res = sink();
      applyUploadRelayHeaders(res, `operator-upload${extension}`);
      expect(res.headers['Content-Disposition']).toBeUndefined();
      // Anchor: the call did run, so "no disposition" is a decision and not a
      // no-op that would also report success if the helper did nothing at all.
      expect(res.headers['Content-Security-Policy']).toBe("default-src 'none'; sandbox");
    },
  );

  it('matches the extension case-insensitively and only at the end of the name', () => {
    const upper = sink();
    applyUploadRelayHeaders(upper, 'LOGO.SVG');
    expect(upper.headers['Content-Disposition']).toBe('attachment');

    const decoy = sink();
    applyUploadRelayHeaders(decoy, 'svg.png');
    expect(decoy.headers['Content-Disposition']).toBeUndefined();
  });
});

describe('rezeis /uploads relay — icons', () => {
  it('sandboxes a relayed icon SVG and forces it to download', async () => {
    const fetchMock = vi.fn(async () => upstream('<svg/>', 'image/svg+xml'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await get(createApp(base()), '/uploads/icons/plan-badge.svg');

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('<svg/>');
    // Exactly the sandbox policy — NOT the app-wide helmet SPA policy, which
    // this response would otherwise inherit and which permits same-origin
    // script and a same-origin document context.
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    // Not a route-level guarantee on its own — helmet also sets this app-wide.
    // The helper suite above is what pins it to this policy.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('attachment');
    // Pre-existing behaviour must survive.
    expect(response.headers['content-type']).toBe('image/svg+xml');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('sandboxes a relayed icon PNG but leaves it inline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream('PNGDATA', 'image/png')));
    const response = await get(createApp(base()), '/uploads/icons/plan-badge.png');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});

describe('rezeis /uploads relay — custom emoji', () => {
  it('sandboxes a relayed emoji SVG and forces it to download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream('<svg/>', 'image/svg+xml')));
    const response = await get(createApp(base()), '/uploads/emoji/party.svg');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('attachment');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('sandboxes a relayed Lottie emoji JSON but leaves it inline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream('{"v":"5"}', 'application/json')));
    const response = await get(createApp(base()), '/uploads/emoji/party.json');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});

describe('rezeis /uploads relay — branding (both cache branches)', () => {
  it('sandboxes a branding SVG on the FETCH branch, with an empty disk cache', async () => {
    const fetchMock = vi.fn(async () => upstream('<svg/>', 'image/svg+xml'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await get(createApp(base()), '/uploads/branding/fetched-logo.svg');

    // The branch is the point of the test: nothing was cached, so this response
    // can only have come from the admin host.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('<svg/>');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('attachment');
  });

  it('sandboxes a branding SVG on the DISK-CACHE branch, with the admin host unreachable', async () => {
    // The branch that survives an admin outage, and the one a partial fix
    // leaves bare. Populate the mirror by hand and make any network call a hard
    // failure, so a response here PROVES the bytes came off disk.
    writeFileSync(path.join(cacheDir, 'cached-logo.svg'), '<svg id="cached"/>');
    const fetchMock = vi.fn(async () => {
      throw new Error('admin host is down — the cache branch must not reach the network');
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await get(createApp(base()), '/uploads/branding/cached-logo.svg');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('<svg id="cached"/>');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('attachment');
    expect(response.headers['content-type']).toBe('image/svg+xml');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('sandboxes a cached branding PNG but leaves it inline', async () => {
    writeFileSync(path.join(cacheDir, 'cached-icon.png'), 'PNGDATA');
    const fetchMock = vi.fn(async () => {
      throw new Error('admin host is down — the cache branch must not reach the network');
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await get(createApp(base()), '/uploads/branding/cached-icon.png');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});

describe('rezeis /uploads relay — FAQ media (Range-capable)', () => {
  const FILE_NAME = '0123456789abcdef0123456789abcdef.mp4';
  const MEDIA_PATH = `/api/v1/faq/media/${FILE_NAME}`;

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => silentLogger,
  };

  function faqApp(downloadMedia: () => Promise<unknown>): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { log: typeof silentLogger }).log = silentLogger;
      next();
    });
    app.use(
      '/api/v1',
      createContentRouter({
        adminClient: { faq: { getPublicFaq: async () => [], downloadMedia } } as never,
        sessionStore: null,
        config: {} as never,
      }),
    );
    return app;
  }

  function media(body: string, overrides: Record<string, unknown> = {}): unknown {
    const payload = Buffer.from(body);
    return {
      status: 200,
      contentType: 'video/mp4',
      contentLength: payload.length,
      contentRange: null,
      acceptRanges: 'bytes',
      etag: '"faq-etag"',
      lastModified: 'Wed, 29 Jul 2026 12:00:00 GMT',
      body: Readable.from(payload),
      ...overrides,
    };
  }

  it('sandboxes a full FAQ media response without disturbing its caching headers', async () => {
    const response = await get(faqApp(async () => media('video-data')), MEDIA_PATH);

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('video-data');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    // No markup extension can reach this route, so nothing is forced to
    // download and inline <video>/<img> keeps working.
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['accept-ranges']).toBe('bytes');
  });

  it('sandboxes a 206 partial FAQ media response and preserves the byte range', async () => {
    const response = await get(
      faqApp(async () =>
        media('data', { status: 206, contentLength: 4, contentRange: 'bytes 10-13/100' }),
      ),
      MEDIA_PATH,
      { Range: 'bytes=10-13' },
    );

    // The header policy must not cost the partial response anything.
    expect(response.status).toBe(206);
    expect(response.body.toString('utf8')).toBe('data');
    expect(response.headers['content-range']).toBe('bytes 10-13/100');
    expect(response.headers['content-length']).toBe('4');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});

function base(): Parameters<typeof createApp>[0] {
  return {
    adminClient: null,
    sessionStore: null,
    webSessionStore: null,
    config: CONFIG,
  };
}

describe('rezeis /uploads relay — the panel is the origin of this policy', () => {
  it('states the upload-policy digest before computing it, over something', () => {
    // THE ANSWER, restated. If someone edits the constant at the top to match a
    // changed policy, this line objects — which is the whole point of writing
    // the expected value down twice.
    expect(UPLOAD_POLICY_DIGEST).toBe(
      '5867b819cfbca6d974151cfd1a2d2ee1dfd3bb81b49927e7537e1941c26ff958',
    );

    // THE CANONICALISER ITSELF, pinned. Both properties this design rests on
    // are asserted here rather than assumed: object keys are SORTED, so the two
    // sides need not write their fields in the same order, and array order is
    // KEPT, so reordering the extension list moves the digest. A canonicaliser
    // that dropped values or sorted arrays would go on producing a perfectly
    // stable digest for a policy it had stopped describing.
    expect(canonicalise(CANONICAL_FIXTURE)).toBe(CANONICAL_FIXTURE_FORM);
    expect(digestOf(CANONICAL_FIXTURE)).toBe(CANONICAL_FIXTURE_DIGEST);

    // NON-VACUITY OF THIS SURFACE. A normalisation that swallowed its input, or
    // a manifest that read back empty, lands on one of the three digests below
    // and would then agree with itself forever.
    const form = canonicalise(PANEL_UPLOAD_POLICY);
    expect(form.length, 'the canonical upload policy came out empty').toBeGreaterThan(200);
    expect(form).toContain('".svg"');
    expect(form).toContain('"Content-Security-Policy"');
    expect(form).toContain('"markupOnly"');
    for (const vacuous of [EMPTY_INPUT_DIGEST, EMPTY_OBJECT_DIGEST, EMPTY_ARRAY_DIGEST]) {
      expect(
        UPLOAD_POLICY_DIGEST,
        'the pinned digest is the digest of nothing — this guard is hashing an empty input',
      ).not.toBe(vacuous);
    }

    // … and only then the committed content, against the answer.
    const computed = digestOf(PANEL_UPLOAD_POLICY);
    expect(
      computed,
      digestDriftMessage(UPLOAD_POLICY_SURFACE, computed, 'reiwa'),
    ).toBe(UPLOAD_POLICY_DIGEST);
  });

  it('holds a policy in the committed manifest, not an empty one', () => {
    // THE ANTI-VACUITY CASE for the manifest itself. Two empty lists compare
    // equal, so a manifest that lost its contents would satisfy every
    // comparison below and report coverage that is not there.
    expect(PANEL_UPLOAD_POLICY.markupExtensions.length, 'the panel markup list is empty').toBe(
      EXPECTED_MARKUP_EXTENSIONS.length,
    );
    expect(PANEL_UPLOAD_POLICY.headers.length, 'the panel header list is empty').toBe(
      EXPECTED_PANEL_HEADERS.length,
    );
    // Every element was a real string literal when it was read, so nothing was
    // swallowed on the way in.
    expect(
      PANEL_UPLOAD_POLICY.markupExtensions.filter((extension) => extension.startsWith('<')),
    ).toEqual([]);
    expect(
      PANEL_UPLOAD_POLICY.headers.filter((header) => header.name.startsWith('<')),
    ).toEqual([]);
  });

  it('agrees with the panel on the markup extension list', () => {
    // The answer …
    expect([...EXPECTED_MARKUP_EXTENSIONS]).toEqual([
      '.svg',
      '.svgz',
      '.xml',
      '.xhtml',
      '.html',
      '.htm',
      '.xht',
    ]);
    // … non-vacuity, restated here so this case cannot pass on an empty list
    // even if it were run alone …
    expect(PANEL_UPLOAD_POLICY.markupExtensions.length).toBeGreaterThan(0);
    // … then the ORIGIN, which is the rule of record for both hosts …
    expect(
      [...PANEL_UPLOAD_POLICY.markupExtensions],
      'rezeis forces a different set of uploads to download than this relay does — an upload the panel will not render is rendered inline in the subscriber session, or vice versa',
    ).toEqual([...EXPECTED_MARKUP_EXTENSIONS]);
    // … and only then this relay's copy of it.
    expect([...MARKUP_UPLOAD_EXTENSIONS]).toEqual([...EXPECTED_MARKUP_EXTENSIONS]);
  });

  it('agrees with the panel on all three headers, and on which is conditional', () => {
    // The answer …
    expect(EXPECTED_CSP).toBe("default-src 'none'; sandbox");
    expect(EXPECTED_NOSNIFF).toBe('nosniff');
    expect(EXPECTED_MARKUP_DISPOSITION).toBe('attachment');

    expect(PANEL_UPLOAD_POLICY.headers.length).toBeGreaterThan(0);

    // … then the origin. Whole-list, so a header ADDED to the panel policy and
    // never mirrored here is as visible as one changed or removed.
    expect(
      PANEL_UPLOAD_POLICY.headers.map((header) => ({ ...header })),
      'the panel sets a different upload header policy than this relay does',
    ).toEqual(EXPECTED_PANEL_HEADERS.map((header) => ({ ...header })));

    // … and only then this relay's copy.
    expect([UPLOAD_RELAY_CSP, UPLOAD_RELAY_NOSNIFF, UPLOAD_RELAY_MARKUP_DISPOSITION]).toEqual([
      EXPECTED_CSP,
      EXPECTED_NOSNIFF,
      EXPECTED_MARKUP_DISPOSITION,
    ]);
  });

  it('finds the panel source wherever the sibling checkout exists', () => {
    // Not a parity assertion — an assertion about this file's own reach. It
    // says in the log which of the two modes the run is in, and it fails
    // outright in the one situation where a skip would be a lie.
    console.info(
      hasPanelSource
        ? `upload-relay parity: reading the panel policy at ${PANEL_MAIN_PATH}`
        : `upload-relay parity: no sibling checkout at ${PANEL_REPO_PATH} — running against the committed manifest`,
    );
    expect([...MARKUP_UPLOAD_EXTENSIONS]).toEqual([...EXPECTED_MARKUP_EXTENSIONS]);

    if (hasSiblingRepo) {
      expect(
        hasPanelSource,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but its entrypoint is not at ${PANEL_MAIN_PATH} — it moved, and the live comparison below is skipping`,
      ).toBe(true);
    }
  });

  // THE LOCAL EXTRA. The only case here that skips, and it is honest about
  // what it is: an additional check available when both trees are on one
  // machine, which can name the extension that differs. The digest above is
  // the floor, and it runs everywhere.
  it.skipIf(!hasPanelSource)('still matches the LIVE panel, when the sibling is here', () => {
    const policy = readPanelPolicy();
    expect(
      policy,
      `neither ${PANEL_EXTENSIONS_NAME} nor ${PANEL_HELPER_NAME} could be read out of ${PANEL_MAIN_PATH} — this file is no longer reading the panel at all`,
    ).not.toBeNull();
    const live = policy as PanelPolicy;
    expect(live.extensions.length, 'the live panel markup list read back empty').toBeGreaterThan(0);
    expect(live.headers.length, 'no setHeader calls were read out of the live panel helper').toBeGreaterThan(0);

    const committed = [...PANEL_UPLOAD_POLICY.markupExtensions];
    const added = live.extensions.filter((extension) => !committed.includes(extension));
    const removed = committed.filter((extension) => !live.extensions.includes(extension));
    expect(
      { added, removed },
      `the live panel's MARKUP_UPLOAD_EXTENSIONS differs from the committed copy in test/support/panel-parity-manifest.ts — regenerate the manifest and update UPLOAD_POLICY_DIGEST in BOTH repositories`,
    ).toEqual({ added: [], removed: [] });
    // Order too, which the set difference above cannot see.
    expect(live.extensions, 'the panel reordered MARKUP_UPLOAD_EXTENSIONS').toEqual(committed);

    expect(
      live.headers.map((header) => ({ ...header })),
      `the live panel's applyUploadResponseHeaders differs from the committed copy in test/support/panel-parity-manifest.ts — regenerate the manifest and update UPLOAD_POLICY_DIGEST in BOTH repositories`,
    ).toEqual(PANEL_UPLOAD_POLICY.headers.map((header) => ({ ...header })));

    // The whole point of the digest: the live panel hashes to the same number
    // the committed literal names.
    const computed = digestOf({
      markupExtensions: live.extensions,
      headers: live.headers.map((header) => ({ ...header })),
    });
    expect(
      computed,
      digestDriftMessage(UPLOAD_POLICY_SURFACE, computed, 'reiwa'),
    ).toBe(UPLOAD_POLICY_DIGEST);
  });
});
