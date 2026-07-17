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
 *   3. If neither is present, reject authenticated web sessions and allow
 *      non-browser/server-to-server requests to use their own authentication.
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

    // Same-origin requests are not CSRF by definition. In single-image
    // mode the SPA is served from the same origin as the API, so the
    // browser's Origin equals the host this request arrived at. We
    // reconstruct that "self origin" from the (proxy-forwarded) Host +
    // scheme so it matches whatever public hostname/port the user opened
    // — 127.0.0.1:5000 in local dev, or the real domain behind the
    // reverse proxy in prod — without depending on REIWA_DOMAIN being set
    // to exactly that value.
    const forwardedProto =
      (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
      req.protocol;
    const hostHeader = req.headers.host as string | undefined;
    const selfOrigin =
      hostHeader && hostHeader.length > 0 ? `${forwardedProto}://${hostHeader}` : null;

    const isAllowed = (candidate: string | null): boolean => {
      if (candidate === null) return false;
      if (allowedOrigin !== null) return candidate === allowedOrigin;
      return selfOrigin !== null && candidate === selfOrigin;
    };

    // If Origin header is present, validate it
    if (origin) {
      if (isAllowed(extractOrigin(origin))) {
        next();
        return;
      }
      // Origin present but doesn't match — reject
      res.status(403).json({ message: "Forbidden: origin not allowed" });
      return;
    }

    // Fall back to Referer header if Origin is absent
    if (referer) {
      if (isAllowed(extractOrigin(referer))) {
        next();
        return;
      }
      // Referer present but doesn't match — reject
      res.status(403).json({ message: "Forbidden: origin not allowed" });
      return;
    }

    // Cookie-authenticated browser requests must prove their origin. Requests
    // without a web session continue to their route-specific authentication,
    // including HMAC-authenticated webhooks.
    if (req.webSession) {
      res.status(403).json({ message: "Forbidden: origin required" });
      return;
    }
    next();
  };
}
