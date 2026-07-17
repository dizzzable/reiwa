import { describe, expect, it } from "vitest";

import { parseUnverifiedTelegramInitData } from "../src/lib/telegram-auth.js";

describe("parseUnverifiedTelegramInitData", () => {
  it("returns only the diagnostic auth date from untrusted data", () => {
    const input = new URLSearchParams({
      hash: "attacker-controlled",
      auth_date: "1700000000",
      user: JSON.stringify({ id: 1, first_name: "untrusted" }),
    }).toString();

    expect(parseUnverifiedTelegramInitData(input)).toEqual({ auth_date: 1700000000 });
  });

  it("rejects malformed diagnostic dates and missing hashes", () => {
    expect(parseUnverifiedTelegramInitData("hash=x&auth_date=NaN")).toBeNull();
    expect(parseUnverifiedTelegramInitData("auth_date=1700000000")).toBeNull();
  });
});
