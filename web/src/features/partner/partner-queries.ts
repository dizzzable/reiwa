/**
 * The partner page's two money reads, under the keys every page shares.
 *
 * `["partner", "info"]` is also read by the purchase and renewal pages (the
 * balance they offer to pay with), so a withdrawal that moves the balance
 * refreshes it there too.
 */

import { getPartnerWithdrawals } from "@/lib/api-client";
import { readPartnerWithdrawals, type PartnerWithdrawal } from "@/lib/api-client/partner";

export const PARTNER_INFO_QUERY_KEY = ["partner", "info"] as const;
export const PARTNER_WITHDRAWALS_QUERY_KEY = ["partner", "withdrawals"] as const;

/** The customer's withdrawal requests, newest first, read into their typed shape. */
export function fetchPartnerWithdrawals(): Promise<PartnerWithdrawal[]> {
  return getPartnerWithdrawals().then(readPartnerWithdrawals);
}
