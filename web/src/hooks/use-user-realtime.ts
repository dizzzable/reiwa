/**
 * useUserRealtime
 * ───────────────
 * Subscribes the PWA to per-user realtime events streamed from
 * rezeis-admin via the reiwa BFF.
 *
 * Flow
 *   reiwa-admin SystemEventsService.emit()
 *      → RealtimeGateway.broadcast (existing admin channel)
 *      → UserRealtimeService.fanOut (new — fans whitelist events to subscribers)
 *      → /api/internal/user/:telegramId/stream (SSE, internal-only)
 *      → reiwa BFF /api/v1/realtime/stream (proxies SSE 1:1)
 *      → EventSource in this hook
 *      → React Query cache invalidation + optional toast
 *
 * Behaviour
 *   - Connects only when the user is authenticated (`useSession()`).
 *   - Uses the browser's built-in `EventSource` reconnection (with the
 *     `withCredentials: true` flag so the reiwa session cookie is sent).
 *   - Invalidates a small set of React Query keys based on event type;
 *     pages that read those keys auto-refetch when something happens.
 *   - Optional `onEvent` callback for components that want the raw
 *     stream (e.g. a notifications drawer with a toast on every event).
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "./use-session";

export type UserRealtimeCategory =
  | "SUBSCRIPTION"
  | "PAYMENT"
  | "PROMOCODE"
  | "REFERRAL"
  | "NOTIFICATION";

export interface UserRealtimeEvent {
  type: string;
  category: UserRealtimeCategory;
  severity: "INFO" | "WARNING" | "ERROR";
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

interface UseUserRealtimeOptions {
  /** Optional raw-stream observer. */
  readonly onEvent?: (event: UserRealtimeEvent) => void;
  /** Whether to surface WARNING/ERROR severity as a sonner toast. Default true. */
  readonly showToasts?: boolean;
}

/**
 * Map of `event.type` → React Query keys to invalidate. Keep in sync
 * with the user-facing query keys used elsewhere in the PWA. The list
 * stays in JS (not the server-side whitelist) so pages can rename their
 * keys without backend changes.
 */
const TYPE_TO_KEYS: Record<string, readonly string[][]> = {
  "subscription.created": [["session"], ["subscription"], ["all-subscriptions"]],
  "subscription.renewed": [["subscription"], ["all-subscriptions"]],
  "subscription.expired": [["subscription"], ["all-subscriptions"], ["activity", "notifications"]],
  "subscription.upgraded": [["subscription"], ["all-subscriptions"]],
  "subscription.trial_granted": [["subscription"], ["session"]],
  "payment.completed": [["activity", "transactions"], ["subscription"], ["session"]],
  "payment.failed": [["activity", "transactions"]],
  "promocode.activated": [["activity", "transactions"], ["subscription"]],
  "referral.qualified": [["referrals"]],
  "referral.reward_issued": [["referrals"], ["session"]],
};

/** Always invalidate notifications — every event also gets persisted there. */
const ALWAYS_INVALIDATE: readonly string[][] = [
  ["activity", "notifications"],
  ["activity", "notifications-unread-count"],
  // Cabinet feed + dashboard bell query keys.
  ["notifications"],
  ["notifications", "unread-count"],
];

const DEBOUNCE_MS = 400;

export function useUserRealtime(options: UseUserRealtimeOptions = {}): void {
  const { isAuthenticated } = useSession();
  const queryClient = useQueryClient();
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const showToasts = options.showToasts ?? true;

  useEffect(() => {
    if (!isAuthenticated) return;
    if (typeof EventSource === "undefined") return;

    const eventSource = new EventSource("/api/v1/realtime/stream", {
      withCredentials: true,
    });

    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    function scheduleInvalidate(key: readonly string[]): void {
      const cacheKey = key.join("::");
      const existing = pending.get(cacheKey);
      if (existing) clearTimeout(existing);
      pending.set(
        cacheKey,
        setTimeout(() => {
          pending.delete(cacheKey);
          queryClient.invalidateQueries({ queryKey: key as unknown as string[] });
        }, DEBOUNCE_MS),
      );
    }

    function handle(event: UserRealtimeEvent): void {
      const keys = TYPE_TO_KEYS[event.type];
      if (keys) for (const key of keys) scheduleInvalidate(key);
      for (const key of ALWAYS_INVALIDATE) scheduleInvalidate(key);

      if (showToasts) {
        if (event.severity === "ERROR") {
          toast.error(event.message);
        } else if (event.severity === "WARNING") {
          toast.warning(event.message);
        } else if (event.type !== "realtime.ready") {
          // INFO events: keep silent except on explicit user-facing types.
          // The map above is intentionally narrow to avoid toast spam.
          if (event.category === "SUBSCRIPTION" || event.category === "PAYMENT") {
            toast.success(event.message);
          }
        }
      }

      onEventRef.current?.(event);
    }

    // The server uses `event:` lines for typed events, but
    // `EventSource.addEventListener` needs each name registered. We
    // register a fallback `message` listener (default channel) AND a
    // listener per known event type so consumers see the correct
    // `event` field too.
    function parse(rawData: string): UserRealtimeEvent | null {
      try {
        return JSON.parse(rawData) as UserRealtimeEvent;
      } catch {
        return null;
      }
    }

    function onMessage(messageEvent: MessageEvent): void {
      const event = parse(messageEvent.data);
      if (event) handle(event);
    }

    eventSource.addEventListener("message", onMessage);
    // Server sends each event with a `event: <type>` line; register the
    // wildcard listeners for all whitelisted types. Browser dispatches
    // them on the matching listener, the generic `message` handler is
    // not invoked for typed events.
    const knownTypes = [
      "realtime.ready",
      ...Object.keys(TYPE_TO_KEYS),
    ];
    for (const type of knownTypes) {
      eventSource.addEventListener(type, onMessage as EventListener);
    }

    eventSource.onerror = () => {
      // Browser auto-reconnects on transient errors. We deliberately
      // don't close the source here — closing kills the auto-reconnect
      // and forces a fresh tab open to recover.
    };

    return () => {
      eventSource.close();
      pending.forEach((handle) => clearTimeout(handle));
      pending.clear();
    };
  }, [isAuthenticated, queryClient, showToasts]);
}
