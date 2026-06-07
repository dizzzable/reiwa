/**
 * Shared HMAC scheme for the internal reiwa ↔ rezeis-admin ↔ bot hops.
 *
 * When the services are split across VPS, these calls cross the public
 * internet. TLS protects the transport, but an HMAC signature over the
 * request adds defense-in-depth: the shared secret never travels on the
 * wire (only a derived signature), the body can't be tampered with, and a
 * signed timestamp gives replay protection independent of TLS.
 *
 * Canonical message (identical to the scheme `AdminTransport` already uses
 * for reiwa → admin requests, so there is ONE internal-HMAC convention):
 *
 *   message   = METHOD "\n" PATH "\n" TIMESTAMP "\n" sha256hex(body)
 *   signature = hex( HMAC-SHA256(secret, message) )
 *
 * Headers:
 *   x-request-timestamp : milliseconds since epoch (Date.now())
 *   x-request-signature : the hex signature above
 *
 * `TIMESTAMP` is milliseconds (Date.now()) for parity with the existing
 * transport implementation. Receivers reject timestamps outside a freshness
 * window (default ±5 min) to bound replay.
 *
 * NOTE: this is distinct from the Stripe-style `t=...,v1=...` signature used
 * by the operator-facing *external* webhook system — that channel targets
 * arbitrary third-party receivers and keeps its own format.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const REQUEST_TIMESTAMP_HEADER = 'x-request-timestamp';
export const REQUEST_SIGNATURE_HEADER = 'x-request-signature';

/** Default replay window: a signed timestamp must be within ±5 minutes. */
export const DEFAULT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

export interface InternalSignatureInput {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  /** Raw request body as sent on the wire (empty string for no body). */
  readonly body: string;
  /** Override the timestamp (testing); defaults to `Date.now()`. */
  readonly timestamp?: string;
}

/** Compute the `{ timestamp, signature }` pair for an outbound internal request. */
export function buildInternalSignature(input: InternalSignatureInput): {
  readonly timestamp: string;
  readonly signature: string;
} {
  const timestamp = input.timestamp ?? Date.now().toString();
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  const message = [input.method.toUpperCase(), input.path, timestamp, bodyHash].join('\n');
  const signature = createHmac('sha256', input.secret).update(message).digest('hex');
  return { timestamp, signature };
}

export interface InternalVerificationInput {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  /** Replay window in ms (default ±5 min). */
  readonly windowMs?: number;
  /** Current time in ms (testing); defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * Constant-time verification of an inbound internal request signature.
 * Returns `false` for any failure (missing headers, stale timestamp,
 * malformed signature, mismatch) — callers treat `false` as "unauthorized".
 */
export function verifyInternalSignature(input: InternalVerificationInput): boolean {
  const { secret, method, path, body, timestamp, signature } = input;
  if (!secret || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  if (Math.abs(now - ts) > windowMs) return false;

  const expected = buildInternalSignature({ secret, method, path, body, timestamp }).signature;
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
