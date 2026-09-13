/**
 * POST /api/v1/connect/handoff/verify — did this cabinet sign the subscription
 * inside a `/connect/open` address?
 *
 * The page asks with two values and nothing else: the SHA-256 of the
 * subscription URL, which it computes itself, and the signature that travelled
 * with the link (`lib/connect-handoff-signature.ts`). The URL and the link stay
 * in the page's fragment. No request carries them, so no access log, proxy or
 * error report on the way can end up holding somebody's subscription.
 *
 *   request   { "digest": <43 base64url>, "signature": <43 base64url> }
 *   200       { "valid": true | false }
 *   400       anything else, including a body that is not JSON at all
 *
 * ── Public, and not a way in ────────────────────────────────────────────────
 *
 * No session: the page asking runs in Safari, a Custom Tab or Telegram's in-app
 * browser, none of which has the Mini App's cookies. The answer is one bit about
 * a value the caller already holds, and a forged yes is a forged HMAC-SHA256,
 * so the global `/api` limiter is all the budget it needs. A POST from another
 * origin is still refused by the CSRF guard in `app.ts`: the page's own POST is
 * same-origin, carries its Origin, and passes that guard with nothing relaxed
 * for this route.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *
 * Log the request body, or let anything cache an answer — `no-store` on every
 * reply, refusals included. That is also why a body that is not JSON is refused
 * HERE: the global JSON parser throws before any route runs, and the app's
 * error handler would answer that with a 500 and write the unparsed body, the
 * signature in it, into the log.
 */
import { Router, type ErrorRequestHandler } from "express";

import type { ReiwaConfig } from "../../config.js";
import { createConnectHandoffSigner, isBase64Url256 } from "../lib/connect-handoff-signature.js";

/** Relative to the `/api/v1` mount. */
const VERIFY_PATH = "/connect/handoff/verify";

const MALFORMED = { message: "digest and signature must each be 32 bytes as 43 base64url characters" };

/**
 * The router, and the one error handler it needs beside it.
 *
 * Mount both in one `app.use("/api/v1", …)`. The handler cannot live inside the
 * router: body-parser's refusal is raised by app-level middleware before any
 * router runs, and Express passes an error only to four-argument handlers
 * further down the app's own stack. A router is a three-argument middleware, so
 * the error skips it whole, handlers inside it included.
 */
export function createConnectHandoffRouter(deps: {
  config: Pick<ReiwaConfig, "REZEIS_INTERNAL_SHARED_SECRET">;
}): [Router, ErrorRequestHandler] {
  const signer = createConnectHandoffSigner(deps.config.REZEIS_INTERNAL_SHARED_SECRET);
  const router = Router();

  router.post(VERIFY_PATH, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input = readVerifyRequest(req.body);
    if (input === null) {
      res.status(400).json(MALFORMED);
      return;
    }
    res.json({ valid: signer.verify(input.digest, input.signature) });
  });

  const refuseUnparsableBody: ErrorRequestHandler = (err, req, res, next) => {
    if (req.method !== "POST" || req.path !== VERIFY_PATH || !isUnparsableJson(err) || res.headersSent) {
      next(err);
      return;
    }
    // Answered without a word to the log: body-parser keeps the text it could
    // not parse on the error as `body`, and pino writes every field of an `err`.
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json(MALFORMED);
  };

  return [router, refuseUnparsableBody];
}

/**
 * `{ digest, signature }`, both well formed, and not one field more.
 *
 * A body that carries anything else — a subscription URL above all — did not
 * come from the page, and answering it would teach a client that the extra
 * field is fine to send.
 */
function readVerifyRequest(body: unknown): { digest: string; signature: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== 2) return null;
  const { digest, signature } = fields;
  return isBase64Url256(digest) && isBase64Url256(signature) ? { digest, signature } : null;
}

/** body-parser's refusal of text it could not read as JSON — which still holds that text. */
function isUnparsableJson(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { type?: unknown }).type === "entity.parse.failed";
}
