/**
 * useAccessMode
 * ─────────────
 * Reads the platform access mode (`PUBLIC` / `INVITED` / `PURCHASE_BLOCKED`
 * / `REG_BLOCKED` / `RESTRICTED`) from `/api/v1/platform-policy`. The query
 * is shared (single key) so every consumer dedupes onto one request, and
 * is cached for 60s to match the reiwa edge `PolicyCache` TTL.
 *
 * Fails open: on error the mode resolves to `PUBLIC` so a transient policy
 * outage never blanks the cabinet behind a "restricted" banner.
 */
import { useQuery } from "@tanstack/react-query";

import { getPlatformPolicy } from "@/lib/api-client";
import type { AccessMode } from "@/types/api";

export interface AccessModeState {
  readonly mode: AccessMode;
  readonly isLoading: boolean;
  /** Convenience flags for the common gates. */
  readonly purchasesBlocked: boolean;
  readonly restricted: boolean;
  readonly registrationBlocked: boolean;
  readonly inviteOnly: boolean;
}

export function useAccessMode(): AccessModeState {
  const { data, isLoading } = useQuery({
    queryKey: ["platform-policy"],
    queryFn: getPlatformPolicy,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const mode: AccessMode = data?.accessMode ?? "PUBLIC";
  return {
    mode,
    isLoading,
    purchasesBlocked: mode === "PURCHASE_BLOCKED" || mode === "RESTRICTED",
    restricted: mode === "RESTRICTED",
    registrationBlocked: mode === "REG_BLOCKED",
    inviteOnly: mode === "INVITED",
  };
}

/**
 * Reads the `renewalAddOns` capability from the same shared platform-policy
 * query. The renewal flow shows its add-on selection step only when this is
 * true — otherwise backend pricing ignores add-on selections. Fails closed
 * (false) on outage/absence so the step is hidden unless the backend confirms
 * the rollout is on.
 */
export function useRenewalAddOnsEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ["platform-policy"],
    queryFn: getPlatformPolicy,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return data?.renewalAddOns === true;
}
