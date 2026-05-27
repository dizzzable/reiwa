import { Request, Response, NextFunction } from "express";

/**
 * CSRF protection middleware using Origin/Referer header validation.
 *
 * Works in conjunction with SameSite=lax cookies (already set on session cookies)
 * to provide defense-in-depth against cross-site request forgery.
 *
 * Strategy:
 * - Safe methods (GET, HEAD, OPTIONS) are always allowed.
 * - For state-changing methods (POST, PUT, DELETE, PATCH):
 *   1. If Origin header is present, validate it matches the allowed origin.
 *   2. If Origin is absent, fall back to Referer header validation.
 *   3. If neither Origin nor Referer is present, allow the request (non-browser
 *      clients like server-to-server calls or curl don't send these headers).
 *   4. If Origin/Referer is present but doesn't match, reject with 403.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfOptions {
  /** The allowed origin URL (e.g., "https://app.example.com") */
  allowedOrigin: string | null;
}

/**
 * Extracts the origin (scheme + host + port) from a URL string.
 * Returns null if the URL cannot be parsed.
 */
function extractOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Creates a CSRF protection middleware.
 *
 * @param options - Configuration with the allowed origin derived from
 *   REIWA_DOMAIN or REIWA_CORS_ORIGIN.
 */
export function createCsrfProtection(options: CsrfOptions) {
  const allowedOrigin = options.allowedOrigin
    ? extractOrigin(options.allowedOrigin)
    : null;

  return function csrfProtection(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Safe methods don't change state — skip validation
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    // For state-changing methods, validate Origin or Referer
    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;

    // If Origin header is present, validate it
    if (origin) {
      const requestOrigin = extractOrigin(origin);
      if (allowedOrigin && requestOrigin === allowedOrigin) {
        next();
        return;
      }
      // Origin present but doesn't match — reject
      res.status(403).json({ message: "Forbidden: origin not allowed" });
      return;
    }

    // Fall back to Referer header if Origin is absent
    if (referer) {
      const refererOrigin = extractOrigin(referer);
      if (allowedOrigin && refererOrigin === allowedOrigin) {
        next();
        return;
      }
      // Referer present but doesn't match — reject
      res.status(403).json({ message: "Forbidden: origin not allowed" });
      return;
    }

    // Neither Origin nor Referer present — allow the request.
    // Non-browser clients (server-to-server, curl, mobile apps) typically
    // don't send these headers. Combined with SameSite=lax cookies, this is
    // safe because browsers always send Origin on cross-origin POST requests.
    next();
  };
}
