/**
 * Route-level helpers for classifying failures bubbling up from the
 * rezeis-admin internal API.
 *
 * `AdminTransport` throws a typed {@link UpstreamError} carrying the exact
 * HTTP `status` and response `body`. Route handlers should branch on the
 * status code instead of string-matching the error message, which is
 * fragile (any upstream wording change silently alters behaviour).
 *
 * For back-compat with plain `Error`s (legacy callers, test fakes that
 * `throw new Error("... → 409: ...")`) the matchers fall back to scanning
 * the message text when the error isn't a typed `UpstreamError`.
 */
import { UpstreamError } from '../../core/errors/index.js';

export interface UpstreamFailure {
  /** Upstream HTTP status, or `null` when the error wasn't an `UpstreamError`. */
  readonly status: number | null;
  /**
   * Human-readable detail: the upstream response body for `UpstreamError`,
   * otherwise the raw `Error.message`. Safe for server-side logs; do NOT
   * forward verbatim to the browser (may contain provider diagnostics).
   */
  readonly message: string;
}

/** Normalise any thrown value into `{ status, message }`. */
export function describeUpstreamError(e: unknown): UpstreamFailure {
  if (e instanceof UpstreamError) {
    return { status: e.status, message: e.body || e.message };
  }
  const message = e instanceof Error ? e.message : String(e ?? '');
  return { status: null, message };
}

/**
 * The machine-readable `code` rezeis-admin puts in a typed error body, when
 * there is one.
 *
 * A handler that collapses a whole status class into one sentence loses the
 * reason. The panel refuses a registration at 403 for several distinct causes
 * — the platform access mode, a missing invite, missing consent to a legal
 * document — and a visitor told "registration is disabled" while it is in fact
 * enabled has no way to act on that. The code is what lets the SPA say which
 * one it was.
 *
 * Reads the top level and one level under `message`, because Nest serialises
 * `new ForbiddenException({ code, ... })` at the top level while some handlers
 * nest the same object under `message`.
 */
export function readUpstreamCode(e: unknown): string | null {
  if (!(e instanceof UpstreamError) || typeof e.body !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(e.body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const top = (parsed as { code?: unknown }).code;
    if (typeof top === 'string' && top.length > 0) return top;
    const nested = (parsed as { message?: unknown }).message;
    if (typeof nested === 'object' && nested !== null) {
      const inner = (nested as { code?: unknown }).code;
      if (typeof inner === 'string' && inner.length > 0) return inner;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the failure represents the given upstream HTTP status.
 * Prefers the typed `UpstreamError.status`; falls back to scanning the
 * message text for plain errors so existing behaviour is preserved.
 */
export function isUpstreamStatus(e: unknown, status: number): boolean {
  if (e instanceof UpstreamError) return e.status === status;
  const message = e instanceof Error ? e.message : String(e ?? '');
  return message.includes(String(status));
}

/**
 * True only for the typed rezeis-admin response that says the authenticated
 * user no longer exists. Do not use a status-only 404 check for this: other
 * missing upstream resources must keep their own error behaviour.
 */
export function isUpstreamUserNotFound(e: unknown): boolean {
  return (
    e instanceof UpstreamError &&
    e.status === 404 &&
    /\buser not found\b/i.test(e.body)
  );
}
