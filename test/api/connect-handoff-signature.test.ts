import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachConnectSignatures,
  createConnectHandoffSigner,
} from "../../src/api/lib/connect-handoff-signature.js";

/**
 * THE CABINET'S SIGNATURE OVER A SUBSCRIPTION URL SAYS "THIS CABINET ISSUED IT"
 * AND NOTHING THAT ANYBODY WITHOUT THE KEY COULD SAY TOO.
 *
 * `/connect/open` is public, and its fragment is whatever the sender wrote. The
 * operator's catalog vouches for the app in a link and not for the subscription
 * inside it, so the page asks the cabinet about the subscription with a digest
 * and this signature (`src/api/lib/connect-handoff-signature.ts`). Every case
 * below is one way that signature could stop meaning what the page needs:
 *
 *   - built from something other than THIS url — a constant, a prefix — so one
 *     subscriber's signature vouches for anybody's subscription;
 *   - keyed by the shared secret directly, or by a label that drifted, so it
 *     means something else that secret signs, or nothing the verify route
 *     recognises;
 *   - checked against a digest the page cannot compute (hex, not raw bytes);
 *   - without the secret, a key that is not fresh per process.
 *
 * The expected values are computed here, independently, from the construction
 * the module documents — never by calling the module to check itself.
 */

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  // Passes straight through; one case below makes it answer "no" on purpose.
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = "shared-secret-of-this-installation-0123456789";
const OTHER_SECRET = "shared-secret-of-another-installation-987654321";
const URL_A = "https://sub.example.test/s/AbC123";
const URL_B = "https://sub.example.test/s/AbC124";

/** K = HMAC-SHA256(secret, "reiwa/connect-handoff/v1"), written out by hand. */
function expectedKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("reiwa/connect-handoff/v1").digest();
}

/** base64url(HMAC-SHA256(K, SHA-256(utf8(url)))), written out by hand. */
function expectedSignature(secret: string, url: string): string {
  return createHmac("sha256", expectedKey(secret))
    .update(createHash("sha256").update(url, "utf8").digest())
    .digest("base64url");
}

/** What the page sends: base64url of the RAW SHA-256 bytes of the url. */
function digestOf(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("base64url");
}

afterEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

describe("the signature is the documented construction", () => {
  it("equals HMAC-SHA256 under the derived key, over the raw digest of the url", () => {
    const signature = createConnectHandoffSigner(SECRET).sign(URL_A);

    expect(signature).toBe(expectedSignature(SECRET, URL_A));
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("keeps a known answer, so the helper above cannot drift together with the module", () => {
    // Computed once from the construction and written down. A change to the
    // label, the hash, the encoding or the key derivation moves this value, and
    // every `/connect/open` address in flight stops verifying with it.
    expect(createConnectHandoffSigner("0".repeat(32)).sign("https://a.test/s")).toBe(
      "0q0EVtTmeAZtN1hAS6FIHMEp9upFASpBB7mUNL77xBY",
    );
  });

  it("is keyed by the DERIVED key, never by the shared secret itself", () => {
    const direct = createHmac("sha256", SECRET)
      .update(createHash("sha256").update(URL_A, "utf8").digest())
      .digest("base64url");

    expect(createConnectHandoffSigner(SECRET).sign(URL_A)).not.toBe(direct);
  });

  it("hashes the url as UTF-8, the way the page's TextEncoder does", () => {
    const url = "https://sub.example.test/s/Ключ?x=1&y=a+b%20c";
    const signer = createConnectHandoffSigner(SECRET);

    expect(signer.sign(url)).toBe(expectedSignature(SECRET, url));
    expect(signer.verify(digestOf(url), signer.sign(url))).toBe(true);
  });
});

describe("a signature vouches for one subscription url and no other", () => {
  it("differs for urls one character apart", () => {
    const signer = createConnectHandoffSigner(SECRET);

    expect(signer.sign(URL_A)).not.toBe(signer.sign(URL_B));
  });

  it("verifies against the digest of its own url", () => {
    const signer = createConnectHandoffSigner(SECRET);

    expect(signer.verify(digestOf(URL_A), signer.sign(URL_A))).toBe(true);
  });

  it("refuses a genuine signature presented with another url's digest", () => {
    // The attack in one line: take a signature the cabinet really issued, for
    // a subscription the sender really holds, and put a different subscription
    // beside it.
    const signer = createConnectHandoffSigner(SECRET);

    expect(signer.verify(digestOf("https://evil.example.test/sub"), signer.sign(URL_A))).toBe(false);
  });

  it("refuses a signature made with another installation's secret", () => {
    const theirs = createConnectHandoffSigner(OTHER_SECRET).sign(URL_A);

    expect(createConnectHandoffSigner(SECRET).verify(digestOf(URL_A), theirs)).toBe(false);
  });

  it("refuses the hex digest a careless client would send, instead of misreading it", () => {
    const signer = createConnectHandoffSigner(SECRET);
    const hex = createHash("sha256").update(URL_A, "utf8").digest("hex");

    expect(signer.verify(hex, signer.sign(URL_A))).toBe(false);
  });
});

describe("verify answers false for anything malformed, and never throws", () => {
  const signer = createConnectHandoffSigner(SECRET);
  const digest = digestOf(URL_A);
  const signature = signer.sign(URL_A);

  it.each([
    ["an empty digest", "", signature],
    ["an empty signature", digest, ""],
    ["a signature one character short", digest, signature.slice(0, 42)],
    ["a signature one character long", digest, `${signature}A`],
    ["padded base64url", digest, `${signature}=`],
    // Forced rather than converted: a digest with no `-` or `_` in it would come
    // out of a `-`→`+` conversion unchanged and prove nothing.
    ["a `+` from the standard base64 alphabet", `+${digest.slice(1)}`, signature],
    ["a `/` from the standard base64 alphabet", digest, `/${signature.slice(1)}`],
    // Same 32 bytes, a second spelling: the two low bits of the last character
    // are not zero. Only the canonical spelling is a signature.
    ["a non-canonical last character", digest, `${signature.slice(0, 42)}${nonCanonical(signature[42] ?? "A")}`],
  ])("%s", (_name, candidateDigest, candidateSignature) => {
    expect(() => signer.verify(candidateDigest, candidateSignature)).not.toThrow();
    expect(signer.verify(candidateDigest, candidateSignature)).toBe(false);
  });

  it("refuses values that are not strings at all", () => {
    expect(signer.verify(42 as unknown as string, signature)).toBe(false);
    expect(signer.verify(digest, null as unknown as string)).toBe(false);
  });
});

describe("the comparison goes through crypto.timingSafeEqual", () => {
  // What this can and cannot show: it proves the verdict is the answer of
  // `timingSafeEqual` over the two 32-byte buffers, so a `===` or
  // `Buffer.equals` put in its place fails here. It does NOT measure timing —
  // that `timingSafeEqual` runs in constant time is Node's promise, and no test
  // in this suite could observe it reliably.
  it("returns what timingSafeEqual answers, for the expected and the provided signature", () => {
    const signer = createConnectHandoffSigner(SECRET);
    const digest = digestOf(URL_A);
    const signature = signer.sign(URL_A);
    vi.mocked(timingSafeEqual).mockClear();
    vi.mocked(timingSafeEqual).mockReturnValueOnce(false);

    expect(signer.verify(digest, signature), "the verdict was not timingSafeEqual's").toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = vi.mocked(timingSafeEqual).mock.calls[0] as unknown as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(Buffer.from(b).toString("base64url")).toBe(signature);
  });
});

describe("without the shared secret", () => {
  it("signs and verifies within one process, with one key for every signer", () => {
    // The list route and the verify route build their own signers; without the
    // secret they must still agree, or nothing would ever verify in development.
    const listSide = createConnectHandoffSigner(undefined);
    const verifySide = createConnectHandoffSigner(null);

    expect(verifySide.verify(digestOf(URL_A), listSide.sign(URL_A))).toBe(true);
  });

  it("uses a key that is not derived from anything guessable", () => {
    const signature = createConnectHandoffSigner(undefined).sign(URL_A);

    expect(signature).not.toBe(expectedSignature("", URL_A));
    expect(signature).not.toBe(expectedSignature("undefined", URL_A));
    expect(signature).not.toBe(createConnectHandoffSigner(SECRET).sign(URL_A));
  });

  it("draws a new key for a new process, so a signature does not survive a restart", async () => {
    const before = createConnectHandoffSigner(undefined).sign(URL_A);

    vi.resetModules();
    const restarted = await import("../../src/api/lib/connect-handoff-signature.js");
    const after = restarted.createConnectHandoffSigner(undefined);

    expect(after.sign(URL_A)).not.toBe(before);
    expect(after.verify(digestOf(URL_A), before)).toBe(false);
  });

  it("does not fall back to the process key when the secret IS set", async () => {
    // A secret-keyed signature must survive a restart: that is what makes an
    // address made just before a deploy still work just after it.
    const before = createConnectHandoffSigner(SECRET).sign(URL_A);

    vi.resetModules();
    const restarted = await import("../../src/api/lib/connect-handoff-signature.js");

    expect(restarted.createConnectHandoffSigner(SECRET).verify(digestOf(URL_A), before)).toBe(true);
  });
});

describe("attachConnectSignatures", () => {
  const signer = createConnectHandoffSigner(SECRET);

  it("signs every subscription that has a url and leaves every other field exactly as it came", () => {
    const payload = {
      subscriptions: [
        { id: "a", url: URL_A, status: "ACTIVE", plan: { id: "p", name: "Plan", type: null } },
        { id: "b", url: null, status: "EXPIRED" },
        { id: "c", url: "", status: "PENDING" },
        { id: "d", status: "ACTIVE" },
      ],
      nextCursor: null,
    };
    const before = JSON.stringify(payload);

    const signed = attachConnectSignatures(payload, signer) as typeof payload & {
      subscriptions: Array<Record<string, unknown>>;
    };

    expect(signed.subscriptions[0]).toEqual({ ...payload.subscriptions[0], connectSignature: expectedSignature(SECRET, URL_A) });
    // Nothing to sign, so nothing added — not even an empty key.
    expect(signed.subscriptions[1]).toEqual(payload.subscriptions[1]);
    expect(signed.subscriptions[2]).toEqual(payload.subscriptions[2]);
    expect(signed.subscriptions[3]).toEqual(payload.subscriptions[3]);
    expect("connectSignature" in (signed.subscriptions[1] ?? {})).toBe(false);
    expect(signed.nextCursor).toBeNull();
    // The upstream object is not written to: it may be a cached value.
    expect(JSON.stringify(payload)).toBe(before);
  });

  it.each([
    ["null", null],
    ["an array", [{ url: URL_A }]],
    ["no subscriptions field", { items: [{ url: URL_A }] }],
    ["subscriptions that are not a list", { subscriptions: { url: URL_A } }],
  ])("passes %s through untouched", (_name, payload) => {
    expect(attachConnectSignatures(payload, signer)).toBe(payload);
  });

  it("leaves a row that is not an object where it was", () => {
    const signed = attachConnectSignatures({ subscriptions: [null, "x", { url: URL_A }] }, signer) as {
      subscriptions: unknown[];
    };

    expect(signed.subscriptions[0]).toBeNull();
    expect(signed.subscriptions[1]).toBe("x");
    expect((signed.subscriptions[2] as Record<string, unknown>)["connectSignature"]).toBe(
      expectedSignature(SECRET, URL_A),
    );
  });
});

/** A last character that decodes to the same bytes but is not the canonical one. */
function nonCanonical(canonical: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return alphabet[alphabet.indexOf(canonical) + 1] ?? "B";
}
