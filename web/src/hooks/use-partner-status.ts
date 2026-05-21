/**
 * `usePartnerStatus`
 * ──────────────────
 * Returns the current user's partner-activation status. Used by the bottom
 * navigation to swap the third tab between **Referral** (default) and
 * **Partner** (when `isActive === true`).
 *
 * Cached for 60 seconds — partner activation is a manual admin operation,
 * so a fresh check on every dashboard mount is wasteful. The cache rides on
 * top of TanStack Query so refetches across multiple consumers de-duplicate
 * automatically.
 */

import { useQuery } from "@tanstack/react-query";

import { getPartnerStatus, type PartnerStatus } from "@/lib/api-client";

const FALLBACK: PartnerStatus = { isActive: false };

export function usePartnerStatus() {
  const query = useQuery<PartnerStatus>({
    queryKey: ["partner-status"],
    queryFn: getPartnerStatus,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    placeholderData: FALLBACK,
  });
  return {
    status: query.data ?? FALLBACK,
    isLoading: query.isLoading,
  };
}
