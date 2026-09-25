/**
 * Reads the panel's «Часовой пояс» once for everything below it — the signed-in
 * shell (`stealth-layout.tsx`) — from the list of the customer's add-ons, which
 * carries it on every answer (`operator-time-zone.ts` says why there).
 */
import { useQuery } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

import { getAddOnEntitlements } from "@/lib/api-client";
import { OperatorTimeZoneContext } from "@/lib/operator-time-zone";
import { customerDateZone } from "@/lib/operator-zone";

export function OperatorTimeZoneProvider({ children }: PropsWithChildren) {
  const { data } = useQuery({
    queryKey: ["add-on-entitlements"],
    queryFn: ({ signal }) => getAddOnEntitlements({ signal }),
    // The zone changes when an operator changes it — rarely; the list's own
    // page refreshes the same answer more often (`my-addons-page.tsx`).
    staleTime: 5 * 60_000,
    retry: 1,
    select: (answer) => answer.displayTimeZone,
  });
  return <OperatorTimeZoneContext.Provider value={customerDateZone(data)}>{children}</OperatorTimeZoneContext.Provider>;
}
