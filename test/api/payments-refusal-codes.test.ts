import { describe, expect, it } from "vitest";

import {
  extractAbandonRefusalCode,
  extractCheckoutRefusalCode,
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
  it.each(["TRIAL_ALREADY_USED", "TRIAL_PENDING_CHECKOUT_STALE"])("forwards %s", (code) => {
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
