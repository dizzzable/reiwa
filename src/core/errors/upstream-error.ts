/**
 * UpstreamError — network / HTTP / authentication failures from the
 * rezeis-admin internal API.
 *
 * Distinct from `DomainError` (expected business outcomes) so the
 * top-level error handler can:
 *   - retry transient failures (502, 503, ECONNRESET) once
 *   - emit a `reiwa.upstream.*` system event to the operator
 *   - render a generic "service unavailable" to the user instead of
 *     leaking provider error bodies
 */
export class UpstreamError extends Error {
  public constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`AdminClient: ${method} ${path} → ${status}: ${body}`);
  }

  /**
   * Heuristic: 5xx and selected 4xx (408 Timeout, 429 Too Many Requests)
   * are worth retrying once. 4xx that aren't 408/429 are *our* fault and
   * retry won't help.
   */
  public get isRetryable(): boolean {
    if (this.status >= 500) return true;
    if (this.status === 408 || this.status === 429) return true;
    return false;
  }

  /** True when admin rejected our auth token (revoked / expired). */
  public get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}
