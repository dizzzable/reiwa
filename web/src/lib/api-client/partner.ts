/**
 * Partner namespace — info, status (lightweight bottom-nav probe),
 * earnings, withdrawals.
 */
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
 * partner balance. Completes synchronously server-side.
 */
export const payWithPartnerBalance = (input: {
  purchaseType: "NEW" | "ADDITIONAL" | "RENEW" | "UPGRADE";
  planId: string;
  durationDays: number;
  subscriptionId?: string;
  deviceType?: string;
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
