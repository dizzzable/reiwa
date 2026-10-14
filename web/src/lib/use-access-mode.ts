/**
 * useAccessMode
 * ─────────────
 * Reads the platform access mode (`PUBLIC` / `INVITED` / `PURCHASE_BLOCKED`
 * / `REG_BLOCKED` / `RESTRICTED`) from `/api/v1/platform-policy`. The query
 * is shared (single key) so every consumer dedupes onto one request, and
 * is cached for 60s to match the reiwa edge `PolicyCache` TTL.
 *
 * A policy that could not be read is UNKNOWN, never `PUBLIC` (the owner's rule
 * of 24.09.2026; `lib/platform-policy-query.ts`): `mode` is `null`, every flag
 * is `false`, and `isLoading` stays `true` — for the first read and for as
 * long as reads keep failing, while the query asks again on its own (3 s →
 * 30 s). A reader that gates something waits on `isLoading` rather than
 * rendering the open variant. Once a policy has been read, a failing refresh
 * keeps it.
 */
import { useQuery } from "@tanstack/react-query";

import { platformPolicyQueryOptions } from "@/lib/platform-policy-query";
import type { AccessMode } from "@/types/api";

export interface AccessModeState {
  /** The operator's access mode; `null` while no policy is known. */
  readonly mode: AccessMode | null;
  /** Whether a policy has been read at all. */
  readonly known: boolean;
  /** `true` until a policy is known — including while every read fails. */
  readonly isLoading: boolean;
  /** Convenience flags for the common gates. */
  readonly purchasesBlocked: boolean;
  readonly restricted: boolean;
  readonly registrationBlocked: boolean;
  readonly inviteOnly: boolean;
}

export function useAccessMode(): AccessModeState {
  const { data } = useQuery(platformPolicyQueryOptions);

  const known = data !== undefined;
  // A read policy without the field keeps its old reading (open); only a
  // policy nobody could read is unknown.
  const mode: AccessMode | null = known ? (data.accessMode ?? "PUBLIC") : null;
  return {
    mode,
    known,
    isLoading: !known,
    purchasesBlocked: mode === "PURCHASE_BLOCKED" || mode === "RESTRICTED",
    restricted: mode === "RESTRICTED",
    registrationBlocked: mode === "REG_BLOCKED",
    inviteOnly: mode === "INVITED",
  };
}

/**
 * «Восстановление пароля по логину» (stored as `subscriptionLinkRecovery`: it was
 * «по ссылке подписки» until the owner decided the login is enough) — the
 * operator's switch, from the same shared platform-policy query. Fails CLOSED: absent (a panel that
 * predates the switch, which has no subscription-recovery endpoint either) and
 * an unanswered policy both read as OFF, so the cabinet never offers a path the
 * panel will refuse. `isLoading` lets a page wait instead of flashing "off" —
 * and it stays `true` while the policy cannot be read at all, so an outage is
 * not presented as the operator having switched the path off.
 *
 * `byLogin` says which screen the panel can take: `true` only when it announced
 * `panel.login-recovery`, so a newer cabinet beside an older panel keeps the
 * screen that asks for the link. It fails closed the same way.
 */
export function useSubscriptionLinkRecovery(): {
  readonly enabled: boolean
  readonly byLogin: boolean
  readonly isLoading: boolean
} {
  const { data } = useQuery(platformPolicyQueryOptions);
  return {
    enabled: data?.subscriptionLinkRecovery === true,
    byLogin: data?.subscriptionRecoveryByLogin === true,
    isLoading: data === undefined,
  };
}
