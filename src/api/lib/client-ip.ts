import type { Request } from "express";

/**
 * The visitor's address, as this edge actually saw it.
 *
 * ── `req.ip` and nothing else ─────────────────────────────────────────────
 *
 * Express resolves it against `trust proxy` (set to 1 in `app.ts`, for the
 * single bundled reverse proxy): it trusts one hop — the socket peer — and so
 * returns the RIGHTMOST `X-Forwarded-For` entry, the one that proxy appended
 * via nginx/angie's `$proxy_add_x_forwarded_for`.
 *
 * ── The trap this function exists to keep closed ──────────────────────────
 *
 * Reading the header directly and taking `split(",")[0]` returns the LEFTMOST
 * entry instead — the one segment a visitor fully controls, because the proxy
 * APPENDS to whatever the browser sent rather than replacing it. Any visitor
 * could send `X-Forwarded-For: 1.2.3.4` and have that address recorded as
 * theirs and handed to Turnstile as their origin.
 *
 * That was a real defect on the guest-support path, and this file exists
 * because a second caller was about to re-derive the same one-liner and, on the
 * evidence, the same mistake with it. The code is trivial; the reasoning above
 * is the part worth having in one findable place.
 */
export function resolveClientIp(req: Request): string | undefined {
  return req.ip ?? undefined;
}
