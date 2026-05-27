/**
 * Partner namespace — info, status (lightweight bottom-nav probe),
 * earnings, withdrawals.
 */
import { apiClient } from "./transport.js";

export interface PartnerStatus {
  isActive: boolean;
}

export const getPartnerInfo = () =>
  apiClient.get("/partner/info").then((r) => r.data);

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
