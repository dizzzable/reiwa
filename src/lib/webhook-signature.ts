/**
 * Verifier for inbound rezeis-admin webhooks (the operator-facing webhook
 * system, NOT the internal reiwa↔admin HMAC).
 *
 * Mirrors rezeis-admin's `buildWebhookSignature`
 * (rezeis-admin/src/modules/webhooks/utils/signature.ts) exactly:
 *
 *   header        = "t=<unix-seconds>,v1=<hex-hmac-sha256>"
 *   signedPayload = "<t>.<rawBody>"
 *   v1            = hex( HMAC-SHA256(secret, signedPayload) )
 *
 * The shared secret is the admin's `WEBHOOK_SECRET_HEADER` (64 alphanumeric
 * chars) — the same value Remnawave→remnashop calls `REMNAWAVE_WEBHOOK_SECRET`.
 * On reiwa it is `REZEIS_WEBHOOK_SECRET`.
 *
 * Replay protection: reject when `t` is outside a freshness window
 * (default ±5 min). Comparison is constant-time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default replay window: the signed timestamp must be within ±5 minutes. */
export const DEFAULT_WEBHOOK_WINDOW_SEC = 5 * 60;

export interface WebhookVerificationInput {
  readonly secret: string;
  /** Value of the `X-Rezeis-Signature` header (`t=...,v1=...`). */
  readonly header: string | undefined;
  /** Raw request body bytes, exactly as received (pre-JSON-parse). */
  readonly body: string;
  /** Replay window in seconds (default ±5 min). */
  readonly windowSec?: number;
  /** Current unix-seconds (testing); defaults to now. */
  readonly nowSec?: number;
}

/** Parse `t=<sec>,v1=<hex>` into its parts (order-independent, tolerant of spaces). */
function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === 'v1') {
      v1 = value;
    }
  }
  if (t === null || v1 === null || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Constant-time verification of an inbound webhook signature. Returns
 * `false` for any failure (missing/malformed header, stale timestamp,
 * mismatch) — callers treat `false` as "reject".
 */
export function verifyWebhookSignature(input: WebhookVerificationInput): boolean {
  const { secret, header, body } = input;
  if (!secret || !header) return false;

  const parsed = parseSignatureHeader(header);
  if (parsed === null) return false;

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const windowSec = input.windowSec ?? DEFAULT_WEBHOOK_WINDOW_SEC;
  if (Math.abs(nowSec - parsed.t) > windowSec) return false;

  const expected = createHmac('sha256', secret)
    .update(`${parsed.t}.${body}`)
    .digest('hex');

  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    providedBuf = Buffer.from(parsed.v1, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
