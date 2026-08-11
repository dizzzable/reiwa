import type { ReiwaConfig } from './app.config.js';

/** Four dot-separated decimal octets, each 0-255. Nothing else. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * `localhost` and anything under it — RFC 6761 reserves the whole tree to the
 * loopback, so it is a local target however many dots it has.
 */
const LOCALHOST = /^localhost$|\.localhost$/i;

/**
 * Address ranges that cannot leave the machine or the private network:
 * loopback, RFC 1918, link-local, IPv6 loopback / unique-local / link-local.
 */
const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6 = /^\[?(::1|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/**
 * What kind of thing the operator put in a host field.
 *
 * MUST stay in step with `classifyPanelHost` in rezeis
 * (`src/modules/remnawave/services/panel-base-url.ts`). The two ends of this
 * integration read the same style of host setting, and a host that means
 * "plain HTTP on this port" on one side and "TLS on 443" on the other is how
 * an afternoon disappears.
 */
type HostKind = 'service' | 'privateLiteral' | 'public';

function classifyHost(host: string): HostKind {
  // A colon cannot appear in a DNS name or a docker service name, so a bare or
  // bracketed IPv6 literal is decided by it alone.
  if (host.includes(':')) return PRIVATE_IPV6.test(host) ? 'privateLiteral' : 'public';
  if (LOCALHOST.test(host)) return 'privateLiteral';
  if (IPV4.test(host)) return PRIVATE_IPV4.test(host) ? 'privateLiteral' : 'public';
  return host.includes('.') ? 'public' : 'service';
}

/** IPv6 has to be bracketed in a URL or the colons read as the port separator. */
function forUrl(host: string): string {
  if (!host.includes(':')) return host;
  return host.startsWith('[') ? host : `[${host}]`;
}

/**
 * Returns the fully-qualified base URL for the rezeis-admin upstream, or
 * `null` when the host is not configured (degraded mode).
 *
 * Resolution rules:
 *  - `REZEIS_HOST` is a docker service name (no dot) → `http://HOST:PORT`
 *  - `REZEIS_HOST` is a PRIVATE address literal — loopback, RFC 1918,
 *    link-local, `localhost`, IPv6 ULA → `http://HOST:PORT`. These contain dots
 *    but are not DNS names, so the old "a dot means a domain" test sent
 *    `10.0.0.5` to `https://10.0.0.5` — TLS on 443, with `REZEIS_PORT`
 *    discarded and nothing said about it.
 *  - anything reachable from the public internet — a domain, or a ROUTABLE IP →
 *    `https://HOST`, port ignored. A routable address is deliberately NOT given
 *    plain HTTP even though it is a literal: that would put
 *    `REZEIS_INTERNAL_SHARED_SECRET` on the wire in clear, and it would be a new
 *    hole rather than a fix, since such a host resolved to `https://` before and
 *    merely failed to connect.
 *
 * Split-VPS is a domain on both sides (see `docs/split-vps-deployment.md`), so
 * that topology is untouched by all of the above.
 *
 * Unlike the rezeis side, this cannot warn about a discarded port: `REZEIS_PORT`
 * has a default (8000), so "the operator set a port" is not a readable signal
 * here — every config has one.
 */
export function resolveRezeisAdminUrl(config: ReiwaConfig): string | null {
  const host = config.REZEIS_HOST?.trim();
  if (!host) return null;
  if (classifyHost(host) === 'public') {
    return `https://${forUrl(host)}`;
  }
  return `http://${forUrl(host)}:${config.REZEIS_PORT}`;
}

/**
 * Returns the canonical public URL of the reiwa web/Mini App.
 *
 * Reads `REIWA_DOMAIN` first, then falls back to the deprecated
 * `REIWA_PUBLIC_WEB_URL`. Accepts either a bare host or a full URL:
 *   - already-qualified `https://...` / `http://...` → returned verbatim
 *   - bare host with a dot → public domain → `https://HOST`
 *   - `localhost[:PORT]` or no dot → local dev / docker → `http://HOST`
 *
 * Trailing slashes are stripped so callers can safely concatenate paths.
 */
export function resolveReiwaPublicUrl(config: ReiwaConfig): string | null {
  const raw = (config.REIWA_DOMAIN ?? config.REIWA_PUBLIC_WEB_URL)?.trim();
  if (!raw) return null;
  const noTrailing = raw.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(noTrailing)) {
    return noTrailing;
  }
  const isLoopbackIp = /^127(?:\.\d{1,3}){3}(?::\d+)?$/.test(noTrailing);
  const isLocal =
    /^localhost(?::\d+)?$/i.test(noTrailing) ||
    isLoopbackIp ||
    !noTrailing.includes('.');
  return isLocal ? `http://${noTrailing}` : `https://${noTrailing}`;
}
