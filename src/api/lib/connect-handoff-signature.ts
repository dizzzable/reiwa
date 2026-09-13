/**
 * connect-handoff-signature
 * ─────────────────────────
 * The cabinet's word that a subscription URL is one it handed to a signed-in
 * subscriber — what lets the public `/connect/open` page tell the operator's
 * own subscription from one somebody else put into a crafted address.
 *
 * ── Why the page cannot decide it alone ─────────────────────────────────────
 *
 * `/connect/open` is public (Safari has none of the Mini App's cookies) and
 * reads its link from the URL fragment, which whoever built the address wrote.
 * The operator's catalog vouches for the SHAPE of that link — the operator's
 * app, the operator's import endpoint — and for nothing inside it: the
 * operator's own `incy://add/{{SUBSCRIPTION_LINK}}` builds
 * `incy://add/https://evil.example/sub` from a stranger's subscription as
 * readily as from the operator's. Without a second check the page offers, on
 * the operator's domain and in the operator's branding, to add whatever
 * subscription the sender chose to the victim's VPN app.
 *
 * ── The scheme ──────────────────────────────────────────────────────────────
 *
 *   K         = HMAC-SHA256(REZEIS_INTERNAL_SHARED_SECRET, "reiwa/connect-handoff/v1")
 *   digest    = SHA-256(utf8(subscriptionUrl))
 *   signature = base64url(HMAC-SHA256(K, digest))                  43 characters
 *
 * `GET /subscriptions/all` signs each of the session user's own subscription
 * URLs (`attachConnectSignatures`), the connect screen carries the signature in
 * the trampoline fragment, and the page asks `POST /connect/handoff/verify`
 * with the digest it computed and that signature — never the URL, never the
 * link (`routes/connect-handoff.ts`).
 *
 * K is DERIVED, never the shared secret itself, so nothing signed here can be
 * mistaken for — or turned into — anything else that secret signs: the internal
 * request HMAC (`lib/internal-hmac.ts`), the webhook relay. A different meaning
 * gets a different label, never this one.
 *
 * ── Without the secret ──────────────────────────────────────────────────────
 *
 * Production refuses to start without it (`core/config/app.config.ts`).
 * Anywhere else a random 32-byte key is drawn once per process: signatures work
 * for the life of that process and die with it, so a `/connect/open` address
 * made before a restart is refused after one.
 *
 * ── What a valid signature does NOT say ─────────────────────────────────────
 *
 * That the subscription belongs to whoever opened the page, or that it is still
 * live. It says this cabinet gave that URL to a signed-in subscriber at some
 * point. The residual is somebody handing somebody else a subscription the
 * OPERATOR issued — which the subscription link itself always allowed.
 *
 * Nothing here logs, and nothing that calls it may log, the key, a signature
 * or a subscription URL.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** What K is derived for. A new meaning gets a new label, never a reuse of this one. */
const KEY_LABEL = "reiwa/connect-handoff/v1";

/**
 * 32 bytes as unpadded base64url: 43 characters, the last carrying four bits of
 * the value and two zero bits — so only these sixteen characters can end one.
 * Anything else is either not a 32-byte value or a second spelling of one.
 */
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** The key used when the shared secret is unset. Never survives the process. */
let processKey: Buffer | null = null;

/** Whether `value` is a digest or a signature as this scheme spells one. */
export function isBase64Url256(value: unknown): value is string {
  return typeof value === "string" && BASE64URL_32_BYTES.test(value);
}

export interface ConnectHandoffSigner {
  /** `base64url(HMAC-SHA256(K, SHA-256(utf8(subscriptionUrl))))`. */
  sign(subscriptionUrl: string): string;
  /**
   * Whether `signature` is this cabinet's signature over the subscription URL
   * whose SHA-256 is `digest`. `false` — never a throw — for anything that is
   * not two well-formed 32-byte values.
   */
  verify(digest: string, signature: string): boolean;
}

export function createConnectHandoffSigner(sharedSecret: string | null | undefined): ConnectHandoffSigner {
  const key =
    typeof sharedSecret === "string" && sharedSecret.length > 0
      ? createHmac("sha256", sharedSecret).update(KEY_LABEL).digest()
      : (processKey ??= randomBytes(32));
  const mac = (digest: Buffer): Buffer => createHmac("sha256", key).update(digest).digest();

  return {
    sign(subscriptionUrl) {
      return mac(createHash("sha256").update(subscriptionUrl, "utf8").digest()).toString("base64url");
    },
    verify(digest, signature) {
      if (!isBase64Url256(digest) || !isBase64Url256(signature)) return false;
      const expected = mac(Buffer.from(digest, "base64url"));
      const provided = Buffer.from(signature, "base64url");
      // Equal lengths by construction; checked anyway, because `timingSafeEqual`
      // throws on a mismatch and a throw here would be a 500 on a public route.
      return provided.length === expected.length && timingSafeEqual(expected, provided);
    },
  };
}

/**
 * `GET /subscriptions/all`'s answer with `connectSignature` on every
 * subscription that has a url, and everything else exactly as it came.
 *
 * Only for that route's answer: it lists the SESSION user's own subscriptions,
 * which is the whole meaning of the signature. A shape it does not recognise
 * passes through untouched, because this must never be the reason a working
 * subscription list turns into an error.
 */
export function attachConnectSignatures(payload: unknown, signer: ConnectHandoffSigner): unknown {
  if (!isRecord(payload) || !Array.isArray(payload["subscriptions"])) return payload;
  return {
    ...payload,
    subscriptions: payload["subscriptions"].map((row: unknown) => {
      if (!isRecord(row)) return row;
      const url = row["url"];
      return typeof url === "string" && url.length > 0 ? { ...row, connectSignature: signer.sign(url) } : row;
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
