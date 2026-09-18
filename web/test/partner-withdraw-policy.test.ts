/**
 * The partner withdrawal as decisions: what the customer typed, in the unit the
 * panel takes; why no request can be made; and what a refusal meant, read from
 * the partner info AFTER it — because the refusal itself reaches the browser as
 * a bare 400.
 *
 * The rules are the panel's (`InternalPartnerController.withdraw`,
 * `PartnersService.createWithdrawalRequest`): a positive whole number of minor
 * units, at most the balance — the debit and the check are one statement, so a
 * request for exactly the whole balance lands it on zero — and free-text method
 * and requisites. There is no minimum beyond one minor unit and no "one pending
 * request at a time".
 */

import { describe, expect, it } from "vitest";

import {
  PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH,
  readPartnerWithdrawals,
  readWithdrawalAnswer,
  type PartnerWithdrawal,
} from "@/lib/api-client/partner";
import {
  checkWithdrawalRequisites,
  explainWithdrawalRefusal,
  findRequestCreatedAnyway,
  formatPartnerMoney,
  parseWithdrawalAmount,
  PARTNER_WITHDRAWAL_MIN_MINOR,
  withdrawalBlock,
} from "@/features/partner/partner-withdraw-policy";

const NOW = Date.parse("2026-09-19T10:00:00.000Z");
const LATER = "2026-09-21T11:30:00.000Z";
const EARLIER = "2026-09-18T11:30:00.000Z";

describe("the amount the customer typed, in minor units", () => {
  it("reads whole units, a comma or a dot, and spaces anywhere", () => {
    expect(parseWithdrawalAmount("1500", 1_000_000)).toEqual({ ok: true, minor: 150_000 });
    expect(parseWithdrawalAmount("1500,5", 1_000_000)).toEqual({ ok: true, minor: 150_050 });
    expect(parseWithdrawalAmount("1500.07", 1_000_000)).toEqual({ ok: true, minor: 150_007 });
    // A pasted, grouped amount — with the no-break space Intl writes for Russian.
    expect(parseWithdrawalAmount(`1${String.fromCharCode(0xa0)}500,50`, 1_000_000)).toEqual({ ok: true, minor: 150_050 });
    expect(parseWithdrawalAmount(" 12 ", 1_000_000)).toEqual({ ok: true, minor: 1_200 });
    expect(parseWithdrawalAmount("150.", 1_000_000)).toEqual({ ok: true, minor: 15_000 });
    expect(parseWithdrawalAmount("007", 1_000_000)).toEqual({ ok: true, minor: 700 });
  });

  it("counts on the digits, never through a float", () => {
    // 0.29 * 100 is 28.999999999999996 in floating point.
    expect(parseWithdrawalAmount("0.29", 1_000)).toEqual({ ok: true, minor: 29 });
    expect(parseWithdrawalAmount("4.35", 1_000)).toEqual({ ok: true, minor: 435 });
    expect(parseWithdrawalAmount("1.13", 1_000)).toEqual({ ok: true, minor: 113 });
  });

  it("refuses what is not an amount — including what a browser's number field would rewrite", () => {
    for (const text of ["abc", "1e3", "-5", "+5", "1,2,3", "1.234", ",5", "12 руб", "0x10"]) {
      expect(parseWithdrawalAmount(text, 1_000_000), text).toEqual({ ok: false, error: "invalid" });
    }
    expect(parseWithdrawalAmount("", 1_000_000)).toEqual({ ok: false, error: "required" });
    expect(parseWithdrawalAmount("   ", 1_000_000)).toEqual({ ok: false, error: "required" });
  });

  it("takes one minor unit and no less — the panel's only minimum", () => {
    expect(PARTNER_WITHDRAWAL_MIN_MINOR).toBe(1);
    expect(parseWithdrawalAmount("0.01", 1_000)).toEqual({ ok: true, minor: 1 });
    expect(parseWithdrawalAmount("0", 1_000)).toEqual({ ok: false, error: "tooSmall" });
    expect(parseWithdrawalAmount("0,00", 1_000)).toEqual({ ok: false, error: "tooSmall" });
  });

  it("takes the whole balance, and not one minor unit more", () => {
    expect(parseWithdrawalAmount("123.45", 12_345)).toEqual({ ok: true, minor: 12_345 });
    expect(parseWithdrawalAmount("123.46", 12_345)).toEqual({ ok: false, error: "tooLarge" });
    expect(parseWithdrawalAmount("99999999999999", 12_345)).toEqual({ ok: false, error: "tooLarge" });
  });
});

describe("the requisites", () => {
  it("are sent trimmed, and must say something", () => {
    expect(checkWithdrawalRequisites("  2200 1234 5678 9012, Т-Банк \n")).toEqual({
      ok: true,
      value: "2200 1234 5678 9012, Т-Банк",
    });
    expect(checkWithdrawalRequisites(" \n\t ")).toEqual({ ok: false, error: "required" });
  });

  it("stop at the cabinet's cap of 500 characters, which the panel's own comment field shares", () => {
    expect(PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH).toBe(500);
    expect(checkWithdrawalRequisites("x".repeat(500))).toMatchObject({ ok: true });
    expect(checkWithdrawalRequisites("x".repeat(501))).toEqual({ ok: false, error: "tooLong" });
  });
});

describe("why «Вывести средства» takes no tap", () => {
  const partner = { balance: 5_000, isActive: true, programAvailable: true, balanceHold: null };

  it("nothing, for an active partner with money and no hold", () => {
    expect(withdrawalBlock(partner, NOW)).toBeNull();
    // An older panel that sends neither flag nor hold refuses nothing.
    expect(withdrawalBlock({ balance: 5_000 }, NOW)).toBeNull();
  });

  it("the hold first, with its end — even over an empty balance", () => {
    const hold = { until: LATER, timezone: "Europe/Moscow" };
    expect(withdrawalBlock({ ...partner, balanceHold: hold }, NOW)).toEqual({ kind: "hold", hold });
    expect(withdrawalBlock({ ...partner, balance: 0, balanceHold: hold }, NOW)).toEqual({ kind: "hold", hold });
  });

  it("not a hold that has ended", () => {
    expect(withdrawalBlock({ ...partner, balanceHold: { until: EARLIER, timezone: null } }, NOW)).toBeNull();
  });

  it("the invited-only program, the partner switched off, and an empty balance, in that order", () => {
    expect(withdrawalBlock({ ...partner, programAvailable: false, isActive: false, balance: 0 }, NOW)).toEqual({
      kind: "invitedOnly",
    });
    expect(withdrawalBlock({ ...partner, isActive: false, balance: 0 }, NOW)).toEqual({ kind: "inactive" });
    expect(withdrawalBlock({ ...partner, balance: 0 }, NOW)).toEqual({ kind: "empty" });
    expect(withdrawalBlock(null, NOW)).toEqual({ kind: "empty" });
  });
});

describe("what a refusal without a reason meant, from the partner info read after it", () => {
  const fresh = { balance: 5_000, isActive: true, programAvailable: true, balanceHold: null };

  it("in the order the panel checks: who may take part, the hold, the switch, the balance", () => {
    const hold = { until: LATER, timezone: null };
    expect(
      explainWithdrawalRefusal({ ...fresh, programAvailable: false, balanceHold: hold, isActive: false, balance: 0 }, 6_000, NOW),
    ).toEqual({ kind: "invitedOnly" });
    expect(explainWithdrawalRefusal({ ...fresh, balanceHold: hold, isActive: false, balance: 0 }, 6_000, NOW)).toEqual({
      kind: "hold",
      hold,
    });
    expect(explainWithdrawalRefusal({ ...fresh, isActive: false, balance: 0 }, 6_000, NOW)).toEqual({ kind: "inactive" });
    expect(explainWithdrawalRefusal(fresh, 6_000, NOW)).toEqual({ kind: "insufficient", balanceMinor: 5_000 });
  });

  it("says nothing it cannot back: enough money and nothing else wrong is a plain failure", () => {
    expect(explainWithdrawalRefusal(fresh, 5_000, NOW)).toEqual({ kind: "failed" });
    // `null` is both "not a partner" and "the panel failed" on this route.
    expect(explainWithdrawalRefusal(null, 5_000, NOW)).toEqual({ kind: "failed" });
  });
});

describe("a request that was created although the answer was lost", () => {
  const asked = { amount: 15_050, method: "card", requisites: "2200 1234, Т-Банк" };
  const row = (over: Partial<PartnerWithdrawal>): PartnerWithdrawal => ({
    id: "w-new",
    amount: 15_050,
    status: "PENDING",
    method: "card",
    requisites: "2200 1234, Т-Банк",
    adminComment: null,
    processedAt: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    ...over,
  });

  it("is the new PENDING request with exactly what was asked for", () => {
    const before = new Set(["w-old"]);
    expect(findRequestCreatedAnyway(before, [row({}), row({ id: "w-old" })], asked)?.id).toBe("w-new");
  });

  it("is never an old one, a different one, or anything when the list was never read", () => {
    const before = new Set(["w-old"]);
    expect(findRequestCreatedAnyway(before, [row({ id: "w-old" })], asked)).toBeNull();
    expect(findRequestCreatedAnyway(before, [row({ amount: 15_000 })], asked)).toBeNull();
    expect(findRequestCreatedAnyway(before, [row({ method: "sbp" })], asked)).toBeNull();
    expect(findRequestCreatedAnyway(before, [row({ requisites: "other" })], asked)).toBeNull();
    expect(findRequestCreatedAnyway(before, [row({ status: "COMPLETED" })], asked)).toBeNull();
    expect(findRequestCreatedAnyway(null, [row({})], asked)).toBeNull();
  });
});

describe("the panel's answers, as they reach the page", () => {
  const created = {
    id: "w-1",
    partnerId: "p-1",
    amount: 15_050,
    status: "PENDING",
    method: "card",
    requisites: "2200 1234",
    adminComment: null,
    processedBy: null,
    processedAt: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    partner: { id: "p-1", isActive: true, user: null },
  };

  it("a created request is a withdrawal", () => {
    expect(readWithdrawalAnswer(created)).toEqual({
      kind: "created",
      withdrawal: {
        id: "w-1",
        amount: 15_050,
        status: "PENDING",
        method: "card",
        requisites: "2200 1234",
        adminComment: null,
        processedAt: null,
        createdAt: "2026-09-19T10:00:00.000Z",
      },
    });
  });

  it("a 2xx `{ error }` is a refusal, never a created request", () => {
    expect(readWithdrawalAnswer({ error: "PARTNER_PROGRAM_INVITED_ONLY" })).toEqual({
      kind: "refused",
      code: "INVITED_ONLY",
    });
    expect(readWithdrawalAnswer({ error: "Partner not found" })).toEqual({ kind: "refused", code: "NOT_A_PARTNER" });
    expect(readWithdrawalAnswer({ error: "User not found" })).toEqual({ kind: "refused", code: "NOT_A_PARTNER" });
    // What the cabinet answers when it has no panel to ask.
    expect(readWithdrawalAnswer({})).toEqual({ kind: "refused", code: "UNKNOWN" });
    expect(readWithdrawalAnswer(null)).toEqual({ kind: "refused", code: "UNKNOWN" });
  });

  it("the list keeps what it can read and drops the rest", () => {
    const rows = readPartnerWithdrawals({
      withdrawals: [
        { ...created, status: "REJECTED", adminComment: "Неверный номер карты", processedAt: "2026-09-19T12:00:00.000Z" },
        { id: "", amount: 1, status: "PENDING" },
        { id: "w-3", amount: "100", status: "PENDING" },
        "junk",
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "w-1", status: "REJECTED", adminComment: "Неверный номер карты" });
    expect(readPartnerWithdrawals({ withdrawals: "nope" })).toEqual([]);
    expect(readPartnerWithdrawals(null)).toEqual([]);
  });
});

describe("money in a sentence", () => {
  it("is the page's own shape, in the balance's own currency", () => {
    expect(formatPartnerMoney(15_050, "RUB")).toBe("150.50 ₽");
    expect(formatPartnerMoney(15_050, "USD")).toBe("150.50 $");
    expect(formatPartnerMoney(1, "USDT")).toBe("0.01 USDT");
    expect(formatPartnerMoney(12_345, null)).toBe("123.45 ₽");
  });
});
