import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config/app.config.js';
import { resolveRezeisAdminUrl } from '../../src/core/config/url-resolver.js';

/**
 * `REZEIS_HOST` used to be classified by one test — "does it contain a dot?" —
 * and every address literal contains dots. `10.0.0.5` therefore resolved to
 * `https://10.0.0.5`, i.e. TLS on 443, with `REZEIS_PORT` discarded and no
 * mention of it anywhere; a plain-HTTP upstream on 8000 was simply unreachable.
 *
 * These pin each family, because the families are the whole of the logic. The
 * same table is asserted on the rezeis side in
 * `rezeis-admin/test/remnawave-api-base-url.spec.ts` — the two must agree, or a
 * host means different things at the two ends of one integration.
 */
function urlFor(env: Record<string, string>): string | null {
  return resolveRezeisAdminUrl(loadConfig({ ...env }));
}

describe('resolveRezeisAdminUrl — a dot does not make an address a domain', () => {
  it('a docker service name takes plain HTTP with its port', () => {
    expect(urlFor({ REZEIS_HOST: 'rezeis', REZEIS_PORT: '8000' })).toBe('http://rezeis:8000');
  });

  it('a public domain takes HTTPS, and the port is ignored', () => {
    expect(urlFor({ REZEIS_HOST: 'admin.example.com', REZEIS_PORT: '8000' })).toBe(
      'https://admin.example.com',
    );
  });

  it('an IPv4 literal takes plain HTTP on the configured port — the reported bug', () => {
    expect(urlFor({ REZEIS_HOST: '10.0.0.5', REZEIS_PORT: '8080' })).toBe('http://10.0.0.5:8080');
  });

  it('a loopback address is local too', () => {
    expect(urlFor({ REZEIS_HOST: '127.0.0.1', REZEIS_PORT: '8000' })).toBe('http://127.0.0.1:8000');
  });

  it('localhost and anything under it are local, dots or not', () => {
    expect(urlFor({ REZEIS_HOST: 'localhost', REZEIS_PORT: '8000' })).toBe('http://localhost:8000');
    expect(urlFor({ REZEIS_HOST: 'admin.localhost', REZEIS_PORT: '8000' })).toBe(
      'http://admin.localhost:8000',
    );
  });

  it('an IPv6 literal is bracketed, and an already-bracketed one is not doubled', () => {
    // Unbracketed, the colons would be read as the port separator.
    expect(urlFor({ REZEIS_HOST: '::1', REZEIS_PORT: '8000' })).toBe('http://[::1]:8000');
    expect(urlFor({ REZEIS_HOST: '[fe80::1]', REZEIS_PORT: '8000' })).toBe('http://[fe80::1]:8000');
  });

  it('a ROUTABLE address keeps HTTPS even though it is a literal', () => {
    // Deliberately not plain HTTP. A routable address means the request crosses
    // the internet, and REZEIS_INTERNAL_SHARED_SECRET travels on it — giving it
    // the port would be a new hole, not a fix, since this host resolved to
    // `https://` before and merely failed to connect.
    expect(urlFor({ REZEIS_HOST: '203.0.113.10', REZEIS_PORT: '8080' })).toBe(
      'https://203.0.113.10',
    );
    expect(urlFor({ REZEIS_HOST: '2606:4700::1111' })).toBe('https://[2606:4700::1111]');
  });

  it('draws the private/public line where the RFCs draw it', () => {
    expect(urlFor({ REZEIS_HOST: '192.168.1.4', REZEIS_PORT: '8000' })).toBe(
      'http://192.168.1.4:8000',
    );
    expect(urlFor({ REZEIS_HOST: '172.16.0.1', REZEIS_PORT: '8000' })).toBe(
      'http://172.16.0.1:8000',
    );
    // 172.32 is outside RFC 1918, so it is routable and stays on TLS.
    expect(urlFor({ REZEIS_HOST: '172.32.0.1', REZEIS_PORT: '8000' })).toBe('https://172.32.0.1');
    expect(urlFor({ REZEIS_HOST: 'fd00::1', REZEIS_PORT: '8000' })).toBe('http://[fd00::1]:8000');
  });

  it('a dotted value that is NOT a valid address stays a public domain', () => {
    // `999.1.1.1` looks numeric but cannot be an address, so the widened rule
    // must not swallow it — it is still a DNS name.
    expect(urlFor({ REZEIS_HOST: '999.1.1.1' })).toBe('https://999.1.1.1');
    expect(urlFor({ REZEIS_HOST: '1.2.3' })).toBe('https://1.2.3');
  });

  it('falls back to the default port when none is configured', () => {
    // Unlike the rezeis side, `REZEIS_PORT` always has a value, which is why
    // this resolver cannot warn about a port being discarded.
    expect(urlFor({ REZEIS_HOST: '10.0.0.5' })).toBe('http://10.0.0.5:8000');
  });

  it('an absent host means degraded mode, not a guess', () => {
    expect(urlFor({})).toBeNull();
  });

  it('a blank host never reaches the resolver — the schema refuses it first', () => {
    // The resolver has its own `?.trim()` fallback, but it is unreachable for a
    // whitespace-only value: `REZEIS_HOST` is `z.string().trim().min(1)`, so a
    // blank one fails validation at startup. Asserting the throw records where
    // the guarantee actually lives instead of pretending the resolver provides
    // it — a test asserting `null` here would have passed for the wrong reason.
    expect(() => urlFor({ REZEIS_HOST: '   ' })).toThrow(/REZEIS_HOST/);
  });
});
