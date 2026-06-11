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
