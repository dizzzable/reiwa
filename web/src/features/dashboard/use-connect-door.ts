import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { getConnectPage } from "@/lib/api-client";

import {
  CONNECT_PAGE_QUERY_KEY,
  connectDoorKind,
  openConnectDoorFromTap,
  openConnectDoorWithoutGesture,
  rememberDashboardCache,
  type ConnectDoorKind,
  type ConnectDoorTarget,
  type GesturelessDoorOutcome,
} from "./connect-door";

export interface ConnectDoor {
  /** `null` until the operator's switch has been read. */
  readonly kind: ConnectDoorKind | null;
  /** A tap on «Подключить» — the button, the banner. */
  readonly openFromTap: (subscription: ConnectDoorTarget | null) => void;
  /** No tap behind it — the deep link. Never opens the external page. */
  readonly openWithoutGesture: (subscription: ConnectDoorTarget) => GesturelessDoorOutcome;
}

/**
 * The operator's connect door, live — for the dashboard, which owns the read.
 *
 * Fetched here as well as on the connect screen, and deliberately: this is
 * what decides where «Подключить» goes, and fetching it on the dashboard also
 * warms the shared cache so the screen opens with its catalog already in hand.
 * The decisions themselves are plain functions in `connect-door.ts`, shared
 * with the pop-up button, which holds no query of its own and reads the cache
 * this hook hands over.
 */
export function useConnectDoor(): ConnectDoor {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: CONNECT_PAGE_QUERY_KEY,
    queryFn: () => getConnectPage(),
    staleTime: 60_000,
  });

  useEffect(() => {
    rememberDashboardCache(queryClient);
  }, [queryClient]);

  const kind = connectDoorKind(data, !isPending);
  return useMemo(
    () => ({
      kind,
      openFromTap: (subscription) => openConnectDoorFromTap(kind, subscription, navigate),
      openWithoutGesture: (subscription) => openConnectDoorWithoutGesture(kind, subscription, navigate),
    }),
    [kind, navigate],
  );
}
