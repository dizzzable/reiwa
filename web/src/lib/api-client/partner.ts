/**
 * Partner namespace — info, status (lightweight bottom-nav probe),
 * earnings, withdrawals.
 */
import type { PartnerBalanceHold } from "@/lib/partner-balance-hold";
import { apiClient } from "./transport.js";

export interface PartnerStatus {
  isActive: boolean;
}

/** Partner info returned by `/partner/info` (null when not a partner). */
export interface PartnerInfo {
  id: string;
  isActive: boolean;
  /** Balance in minor units (cents/kopecks). */
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  programAvailable: boolean;
  /** Operator allows paying for subscriptions with the partner balance. */
  balancePaymentEnabled: boolean;
  /** Currency the balance is denominated in (e.g. "RUB"). */
  balanceCurrency: string | null;
  /**
   * The hold after a password recovery by subscription link: until `until`
   * nothing leaves the balance. `null` when there is none; absent from a panel
   * older than the hold's report — read both through `standingBalanceHold`.
   */
  balanceHold?: PartnerBalanceHold | null;
  /**
   * The operator's minimum withdrawal, in minor units of `balanceCurrency`;
   * `0` when none is set. Absent from a panel from before it was enforced —
   * read it through `withdrawalMinimum` (partner feature), never directly.
   */
  minWithdrawalAmount?: number;
  createdAt: string;
}

/** Result of a partner-balance payment (mirrors the checkout shape). */
export interface PartnerBalancePayResult {
  paymentId?: string;
  transactionStatus?: string;
  amount?: string;
  currency?: string;
}

export interface PartnerReferralUser {
  id: string;
  label: string;
  level: number;
  invitedAt: string;
}

export interface PartnerReferralsResponse {
  items: PartnerReferralUser[];
  total: number;
  page: number;
  limit: number;
}

export const getPartnerInfo = () =>
  apiClient.get<PartnerInfo | null>("/partner/info").then((r) => r.data);

/**
 * Pay for a subscription (new / additional / renew / upgrade) with the
 * partner balance. Completes synchronously server-side. No `deviceType`, as in
 * the checkout (`payments.ts`).
 */
export const payWithPartnerBalance = (input: {
  purchaseType: "NEW" | "ADDITIONAL" | "RENEW" | "UPGRADE";
  planId: string;
  durationDays: number;
  subscriptionId?: string;
}) =>
  apiClient.post<PartnerBalancePayResult>("/partner/pay", input).then((r) => r.data);

export const getPartnerReferrals = (page = 1, limit = 6) =>
  apiClient
    .get<PartnerReferralsResponse>("/partner/referrals", { params: { page, limit } })
    .then((r) => r.data);

/**
 * Lightweight partner-status flag used by the bottom-nav to swap the
 * third tab between Referral and Partner. Returns instantly for users
 * without partner activation.
 */
export const getPartnerStatus = () =>
  apiClient.get<PartnerStatus>("/partner/status").then((r) => r.data);

export const getPartnerEarnings = () =>
  apiClient.get("/partner/earnings").then((r) => r.data);

export const getPartnerWithdrawals = () =>
  apiClient.get("/partner/withdrawals").then((r) => r.data);

export const createWithdrawal = (data: {
  amount: number;
  method: string;
  requisites: string;
}) =>
  apiClient.post("/partner/withdraw", data).then((r) => r.data);

// ── Withdrawals: what the panel takes and what it answers ───────────────────
//
// Read from the panel's own code (`InternalPartnerController.withdraw` and
// `PartnersService.createWithdrawalRequest`), because the route declares no
// DTO and the rules exist nowhere else:
//   - `amount` is minor units of the balance currency, a positive integer, at
//     most the balance and at least the operator's «Минимальная сумма вывода»
//     (`PartnerInfo.minWithdrawalAmount`, `0` when none is set). The minimum is
//     read, and the balance checked and debited, inside one transaction; the
//     debit and the balance check are one statement, so a request for the whole
//     balance lands it on exactly zero.
//   - `method` and `requisites` are free text the panel stores as they come; the
//     operator reads both in «Выплаты партнёрам» — the four methods below by
//     name, anything else as it came — and pays by hand. No length limit and no
//     format check exists on that side.
//   - There is NO "one pending request at a time".
//   - A refusal comes with a code and a 4xx: 409 for the program's or the
//     partner's state, 422 for an amount the panel cannot take — forwarded by
//     the cabinet (`readWithdrawalRefusal` below) — and the recovery hold with
//     its own code (`partner-balance-hold.ts`).
//   - A panel from before those codes enforces no minimum and sends none. It
//     answers three refusals with a 2xx body `{ error }` instead —
//     `PARTNER_PROGRAM_INVITED_ONLY`, `Partner not found`, `User not found` —
//     which a caller that only catches would report as a created request
//     (`readWithdrawalAnswer`), and every other one with a bare 400 (the
//     cabinet strips the panel's sentence).

/** A withdrawal request as `GET /partner/withdrawals` lists it. */
export interface PartnerWithdrawal {
  readonly id: string;
  /** Minor units of the balance currency. */
  readonly amount: number;
  /**
   * `PENDING` → `COMPLETED` (paid) or `REJECTED` (money back on the balance);
   * `CANCELED` exists in the panel's vocabulary but nothing sets it today. Kept
   * a string: a status this build does not know is shown as it came.
   */
  readonly status: string;
  readonly method: string;
  readonly requisites: string;
  /** The operator's note, usually the reason for a rejection. */
  readonly adminComment: string | null;
  readonly processedAt: string | null;
  readonly createdAt: string;
}

/** The payout methods this cabinet offers, sent to the panel exactly as written here. */
export const PARTNER_WITHDRAWAL_METHODS = ["card", "sbp", "crypto", "other"] as const;
export type PartnerWithdrawalMethod = (typeof PARTNER_WITHDRAWAL_METHODS)[number];

/**
 * A cabinet-side cap on the requisites, not a panel rule (the panel has none):
 * the operator's own comment on a withdrawal stops at the same 500.
 */
export const PARTNER_WITHDRAWAL_REQUISITES_MAX_LENGTH = 500;

/** Why the panel refused a request it answered with a 2xx `{ error }` body. */
export type PartnerWithdrawalRefusalCode = "INVITED_ONLY" | "NOT_A_PARTNER" | "UNKNOWN";

export type PartnerWithdrawalAnswer =
  | { readonly kind: "created"; readonly withdrawal: PartnerWithdrawal }
  | { readonly kind: "refused"; readonly code: PartnerWithdrawalRefusalCode };

/** One list entry, or `null` when the value is not a withdrawal at all. */
export function readPartnerWithdrawal(value: unknown): PartnerWithdrawal | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row["id"] !== "string" || row["id"].length === 0) return null;
  const amount = row["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (typeof row["status"] !== "string" || row["status"].length === 0) return null;
  const text = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
  const optional = (key: string): string | null =>
    typeof row[key] === "string" && (row[key] as string).length > 0 ? (row[key] as string) : null;
  return {
    id: row["id"],
    amount,
    status: row["status"],
    method: text("method"),
    requisites: text("requisites"),
    adminComment: optional("adminComment"),
    processedAt: optional("processedAt"),
    createdAt: text("createdAt"),
  };
}

/** The list from `GET /partner/withdrawals`, newest first; anything unreadable is dropped. */
export function readPartnerWithdrawals(data: unknown): PartnerWithdrawal[] {
  if (typeof data !== "object" || data === null) return [];
  const list = (data as { withdrawals?: unknown }).withdrawals;
  if (!Array.isArray(list)) return [];
  const rows: PartnerWithdrawal[] = [];
  for (const entry of list) {
    const row = readPartnerWithdrawal(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * What a 2xx answer to `POST /partner/withdraw` means. Only a body that IS a
 * withdrawal is a created request: `{ error }` is a refusal, and so is anything
 * else (`{}` when the cabinet has no panel to ask).
 */
export function readWithdrawalAnswer(data: unknown): PartnerWithdrawalAnswer {
  const withdrawal = readPartnerWithdrawal(data);
  if (withdrawal !== null) return { kind: "created", withdrawal };
  const error =
    typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined;
  if (error === "PARTNER_PROGRAM_INVITED_ONLY") return { kind: "refused", code: "INVITED_ONLY" };
  if (error === "Partner not found" || error === "User not found") {
    return { kind: "refused", code: "NOT_A_PARTNER" };
  }
  return { kind: "refused", code: "UNKNOWN" };
}

/**
 * The refusals a current panel names with a code, forwarded by the cabinet
 * (`src/api/routes/partner-errors.ts`): 409 for the program's or the partner's
 * state, 422 for an amount it cannot take. A panel from before them answers the
 * old way — a 2xx `{ error }` body (`readWithdrawalAnswer`) or a bare 400.
 */
export type PartnerWithdrawalRefusalReason =
  | "PARTNER_NOT_FOUND"
  | "PARTNER_PROGRAM_INVITED_ONLY"
  | "PARTNER_NOT_ACTIVE"
  | "WITHDRAWAL_INSUFFICIENT_BALANCE"
  | "WITHDRAWAL_BELOW_MINIMUM";

const WITHDRAWAL_REFUSAL_REASONS: ReadonlySet<string> = new Set<PartnerWithdrawalRefusalReason>([
  "PARTNER_NOT_FOUND",
  "PARTNER_PROGRAM_INVITED_ONLY",
  "PARTNER_NOT_ACTIVE",
  "WITHDRAWAL_INSUFFICIENT_BALANCE",
  "WITHDRAWAL_BELOW_MINIMUM",
]);

/**
 * The coded refusal behind a failed `/partner/withdraw`, or `null` when the
 * failure is anything else. `minWithdrawalAmount` is the minimum a
 * `WITHDRAWAL_BELOW_MINIMUM` carried, or `null` when it carried none usable.
 */
export function readWithdrawalRefusal(
  err: unknown,
): { readonly code: PartnerWithdrawalRefusalReason; readonly minWithdrawalAmount: number | null } | null {
  if (typeof err !== "object" || err === null) return null;
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
  const status = response?.status;
  if (typeof status !== "number" || status < 400 || status > 499 || status === 401 || status === 403) return null;
  const data = response?.data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  if (typeof code !== "string" || !WITHDRAWAL_REFUSAL_REASONS.has(code)) return null;
  const minimum = (data as { minWithdrawalAmount?: unknown }).minWithdrawalAmount;
  return {
    code: code as PartnerWithdrawalRefusalReason,
    minWithdrawalAmount:
      code === "WITHDRAWAL_BELOW_MINIMUM" && typeof minimum === "number" && Number.isSafeInteger(minimum) && minimum >= 0
        ? minimum
        : null,
  };
}
