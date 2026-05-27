import type { ReiwaConfig } from './app.config.js';

/**
 * Returns the fully-qualified base URL for the rezeis-admin upstream, or
 * `null` when the host is not configured (degraded mode).
 *
 * Resolution rules:
 *  - `REZEIS_HOST` without a dot → docker service name → `http://HOST:PORT`
 *  - `REZEIS_HOST` with a dot    → public domain      → `https://HOST` (port ignored)
 */
export function resolveRezeisAdminUrl(config: ReiwaConfig): string | null {
  const host = config.REZEIS_HOST?.trim();
  if (!host) return null;
  const looksLikeDockerService = !host.includes('.');
  if (looksLikeDockerService) {
    return `http://${host}:${config.REZEIS_PORT}`;
  }
  return `https://${host}`;
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
  const isLocal = /^localhost(:\d+)?$/i.test(noTrailing) || !noTrailing.includes('.');
  return isLocal ? `http://${noTrailing}` : `https://${noTrailing}`;
}
