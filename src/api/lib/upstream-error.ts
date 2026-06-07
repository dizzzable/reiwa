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
 * True when the failure represents the given upstream HTTP status.
 * Prefers the typed `UpstreamError.status`; falls back to scanning the
 * message text for plain errors so existing behaviour is preserved.
 */
export function isUpstreamStatus(e: unknown, status: number): boolean {
  if (e instanceof UpstreamError) return e.status === status;
  const message = e instanceof Error ? e.message : String(e ?? '');
  return message.includes(String(status));
}
