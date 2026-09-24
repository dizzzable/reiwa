import { describe, expect, it } from "vitest";

import {
  extractAbandonRefusalCode,
  extractCheckoutRefusalCode,
  extractCheckoutRefusalReason,
} from "../../src/api/routes/payments-errors.js";

/**
 * These two codes are the whole reason the paid-trial refusals were split
 * apart. `TRIAL_ALREADY_USED` means "spent, nothing to do";
 * `TRIAL_PENDING_CHECKOUT_STALE` means "your own unfinished attempt is in the
 * way — finish or cancel it". Collapsed into the generic 500 the BFF used to
 * send, they read identically to the buyer, which is exactly the confusion the
 * original bug report described.
 *
 * The forwarding is deliberately an ALLOW-LIST: an unrecognised upstream code
 * must not be reflected to the client, or an internal identifier could leak
 * into a user-facing response.
 */

const nested = (code: string): string => JSON.stringify({ message: { code, message: "x" } });

describe("checkout refusal codes", () => {
  it.each([
    "TRIAL_ALREADY_USED",
    "TRIAL_PENDING_CHECKOUT_STALE",
    // Any quote the panel will not turn into a draft. From a panel older than
    // PAYMENT_DRAFT_PLAN_NOT_AVAILABLE this is also how a withdrawn plan arrives.
    "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE",
    // A plan or term withdrawn while the buyer still had the old catalogue on screen.
    "PAYMENT_DRAFT_PLAN_NOT_AVAILABLE",
    // «для автоматического списания» refused for this purchase; the page offers the ordinary payment.
    "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE",
    // The buyer holds a trial; the purchase converts it instead. The page re-reads
    // the subscriptions and prices the conversion.
    "TRIAL_UPGRADE_REQUIRED",
    // A renewal of a subscription with no end date, which is never renewed.
    "SUBSCRIPTION_IS_LIFETIME",
  ])("forwards %s", (code) => {
    expect(extractCheckoutRefusalCode(JSON.stringify({ code, message: "x" }))).toBe(code);
  });

  it("reads the code out of the filter's `errorCode` field too", () => {
    // AdminSafeExceptionFilter sets both `code` and `errorCode`; a body that
    // carries only the latter must still be recognised.
    expect(
      extractCheckoutRefusalCode(JSON.stringify({ errorCode: "TRIAL_ALREADY_USED" })),
    ).toBe("TRIAL_ALREADY_USED");
  });

  it("reads the nested Nest shape", () => {
    expect(extractCheckoutRefusalCode(nested("TRIAL_PENDING_CHECKOUT_STALE"))).toBe(
      "TRIAL_PENDING_CHECKOUT_STALE",
    );
  });

  it.each([
    ["an unrelated product code", JSON.stringify({ code: "SUBSCRIPTION_LIMIT_REACHED" })],
    ["an internal code", JSON.stringify({ code: "INTERNAL_DB_LEAK_CODE" })],
    ["an abandon code on the checkout path", JSON.stringify({ code: "PAYMENT_ALREADY_AT_PROVIDER" })],
    ["a body with no code", JSON.stringify({ message: "plain text" })],
    ["a non-JSON body", "<html>502 Bad Gateway</html>"],
    ["an empty body", ""],
  ])("does not forward %s", (_name, body) => {
    expect(extractCheckoutRefusalCode(body)).toBeUndefined();
  });
});

describe("checkout refusal reasons", () => {
  const AUTOPAY = "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE";

  it("forwards the reason of an autopay refusal, at the top level or nested", () => {
    expect(extractCheckoutRefusalReason(JSON.stringify({ code: AUTOPAY, reason: "PENDING_SIGN_UP" }), AUTOPAY)).toBe(
      "PENDING_SIGN_UP",
    );
    expect(
      extractCheckoutRefusalReason(JSON.stringify({ message: { code: AUTOPAY, reason: "PLAN_CHANGE" } }), AUTOPAY),
    ).toBe("PLAN_CHANGE");
  });

  it.each([
    ["a reason outside the allowlist", JSON.stringify({ code: AUTOPAY, reason: "/api/internal/payments/checkout" }), AUTOPAY],
    ["a reason that is not a string", JSON.stringify({ code: AUTOPAY, reason: { sql: "SELECT 1" } }), AUTOPAY],
    ["a reason on a code that carries none", JSON.stringify({ code: "TRIAL_ALREADY_USED", reason: "PENDING_SIGN_UP" }), "TRIAL_ALREADY_USED"],
    ["a body with no reason", JSON.stringify({ code: AUTOPAY }), AUTOPAY],
    ["a non-JSON body", "<html>502 Bad Gateway</html>", AUTOPAY],
  ])("does not forward %s", (_name, body, code) => {
    expect(extractCheckoutRefusalReason(body, code)).toBeUndefined();
  });
});

describe("abandon refusal codes", () => {
  it.each(["PAYMENT_ALREADY_AT_PROVIDER", "PAYMENT_PROVIDER_CREATE_IN_FLIGHT"])(
    "forwards %s",
    (code) => {
      expect(extractAbandonRefusalCode(JSON.stringify({ code, message: "x" }))).toBe(code);
    },
  );

  it("does not forward a checkout code on the abandon path", () => {
    // The two sets are answered by different UI. Crossing them would show a
    // "finish or cancel your attempt" message where a cancel just failed.
    expect(
      extractAbandonRefusalCode(JSON.stringify({ code: "TRIAL_ALREADY_USED" })),
    ).toBeUndefined();
  });

  it("does not forward an unrecognised code", () => {
    expect(
      extractAbandonRefusalCode(JSON.stringify({ code: "SOME_INTERNAL_STATE" })),
    ).toBeUndefined();
  });
});
