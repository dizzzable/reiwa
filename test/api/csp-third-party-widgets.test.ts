import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';

/**
 * The emitted `Content-Security-Policy` header.
 *
 * Two operator-facing features load third-party resources and are therefore
 * governed by this header rather than by any code path a unit test can reach:
 *
 *   • Cloudflare Turnstile — the guest-support page injects
 *     `challenges.cloudflare.com/turnstile/v0/api.js`, the widget renders in an
 *     iframe on that origin and posts the challenge back over XHR. With the
 *     script blocked, no token is ever produced and `POST /support/guest`
 *     answers `400 captcha_failed` for EVERY visitor — the anti-spam toggle
 *     becomes a wall.
 *   • Telegram Login Widget — the script comes from `telegram.org` (already
 *     allowed) but renders through an iframe on `oauth.telegram.org`, and
 *     `frame-src` has no default of its own: it falls back to
 *     `default-src 'self'`, so the button renders nothing.
 *
 * Reading `app.ts` cannot prove either case, because what matters is the
 * serialized header helmet actually emits after merging `useDefaults`. So this
 * asserts the real header, pinning both the new origins and every directive
 * that was already there.
 */

/**
 * Drives one request through the real app pipeline and returns the emitted
 * headers. Deliberately socket-free: an `IncomingMessage`/`ServerResponse`
 * pair is enough to exercise every middleware, so no port is ever bound.
 */
async function emittedHeaders(
  app: ReturnType<typeof createApp>,
  requestPath: string,
): Promise<{ readonly status: number; readonly csp: string }> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  const request = new IncomingMessage(socket);
  request.method = 'GET';
  request.url = requestPath;
  request.headers = { host: '127.0.0.1' };
  const response = new ServerResponse(request);

  const settled = new Promise<{ status: number; csp: string }>((resolve) => {
    const capture = (): void =>
      resolve({
        status: response.statusCode,
        csp: String(response.getHeader('content-security-policy') ?? ''),
      });
    (response as unknown as { write: unknown }).write = (): boolean => true;
    (response as unknown as { end: unknown }).end = (): ServerResponse => {
      capture();
      return response;
    };
  });

  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(request, response);
  request.push(null);
  return settled;
}

function directives(csp: string): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    const [name, ...values] = tokens;
    if (name) map.set(name, values);
  }
  return map;
}

function buildApp(): ReturnType<typeof createApp> {
  return createApp({
    adminClient: null,
    sessionStore: null,
    webSessionStore: null,
    config: { NODE_ENV: 'test', REIWA_BOT_INTERNAL_URL: 'http://127.0.0.1:1' } as never,
  });
}

describe('Content-Security-Policy for the third-party widgets', () => {
  it('allows the Turnstile script, its XHR and its iframe', async () => {
    const { status, csp } = await emittedHeaders(buildApp(), '/api/v1/health');
    const policy = directives(csp);

    expect(status).toBe(200);
    // The loader is injected as a <script> element, so BOTH script-src and the
    // more specific script-src-elem have to name the origin — script-src-elem
    // wins where present, and helmet emits both.
    expect(policy.get('script-src')).toContain('https://challenges.cloudflare.com');
    expect(policy.get('script-src-elem')).toContain('https://challenges.cloudflare.com');
    // The widget posts the solved challenge back to its own origin.
    expect(policy.get('connect-src')).toContain('https://challenges.cloudflare.com');
    // The challenge itself renders in an iframe.
    expect(policy.get('frame-src')).toContain('https://challenges.cloudflare.com');
  });

  it('allows the Telegram Login Widget iframe origin', async () => {
    const { csp } = await emittedHeaders(buildApp(), '/api/v1/health');
    const policy = directives(csp);

    // The script origin was already allowed; the iframe origin is a different
    // host and was not, which is why the button rendered nothing.
    expect(policy.get('script-src')).toContain('https://telegram.org');
    expect(policy.get('frame-src')).toContain('https://oauth.telegram.org');
  });

  it('emits frame-src at all (it has no default and fell back to default-src)', async () => {
    const { csp } = await emittedHeaders(buildApp(), '/api/v1/health');
    expect(directives(csp).has('frame-src')).toBe(true);
    // `'self'` is kept so adding the directive does not narrow the
    // same-origin framing that was previously inherited from `default-src`.
    expect(directives(csp).get('frame-src')).toContain("'self'");
  });

  it('still emits every directive it had before, unchanged', async () => {
    const { csp } = await emittedHeaders(buildApp(), '/api/v1/health');
    const policy = directives(csp);

    // frame-ancestors is the Mini App embedding contract — untouched.
    expect(policy.get('frame-ancestors')).toEqual([
      "'self'",
      'https://web.telegram.org',
      'https://*.telegram.org',
      'https://*.t.me',
    ]);
    expect(policy.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(policy.get('media-src')).toEqual(["'self'", 'blob:', 'https:']);
    // helmet's `useDefaults` set, which the explicit overrides must not drop.
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('font-src')).toEqual(["'self'", 'https:', 'data:']);
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('script-src-attr')).toEqual(["'none'"]);
    expect(policy.get('style-src')).toEqual(["'self'", 'https:', "'unsafe-inline'"]);
    expect(policy.has('upgrade-insecure-requests')).toBe(true);
    // The pre-existing script/connect sources survive alongside the new one.
    expect(policy.get('script-src')).toContain("'self'");
    expect(policy.get('script-src-elem')).toContain("'self'");
    expect(policy.get('connect-src')).toContain("'self'");
    expect(policy.get('connect-src')).toContain('https://telegram.org');
  });

  it('does not widen the script/connect/frame surface beyond those two origins', async () => {
    const { csp } = await emittedHeaders(buildApp(), '/api/v1/health');
    const policy = directives(csp);

    for (const name of ['script-src', 'script-src-elem', 'connect-src', 'frame-src']) {
      const values = policy.get(name) ?? [];
      // No blanket scheme source and no eval/inline escape hatch: a wildcard
      // `https:` here would let any host run script or receive cabinet XHR.
      expect(values, name).not.toContain('https:');
      expect(values, name).not.toContain('*');
      expect(values, name).not.toContain("'unsafe-eval'");
      expect(values, name).not.toContain("'unsafe-inline'");
    }
    expect(policy.get('script-src')).toEqual([
      "'self'",
      'https://telegram.org',
      'https://challenges.cloudflare.com',
    ]);
    expect(policy.get('frame-src')).toEqual([
      "'self'",
      'https://challenges.cloudflare.com',
      'https://oauth.telegram.org',
    ]);
  });
});
