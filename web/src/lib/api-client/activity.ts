/**
 * Activity namespace — transactions ledger + notifications inbox.
 */
import { apiClient } from "./transport.js";
import type { NotificationsResponse, TransactionsResponse, AddOnEntitlementsResponse } from "@/types/api";

interface ActivityRequestOptions {
  readonly signal?: AbortSignal;
}

export const getTransactions = (
  page = 1,
  limit = 20,
  options: ActivityRequestOptions = {},
) =>
  apiClient
    .get<TransactionsResponse>("/activity/transactions", {
      params: { page, limit },
      signal: options.signal,
    })
    .then((r) => r.data);

export const getAddOnEntitlements = (
  options: ActivityRequestOptions = {},
) =>
  apiClient
    .get<AddOnEntitlementsResponse>("/activity/add-on-entitlements", {
      signal: options.signal,
    })
    .then((r) => r.data);

export const getNotifications = (
  page = 1,
  limit = 20,
  options: ActivityRequestOptions = {},
) =>
  apiClient
    .get<NotificationsResponse>("/activity/notifications", {
      params: { page, limit },
      signal: options.signal,
    })
    .then((r) => r.data);

export const getUnreadCount = (
  options: ActivityRequestOptions = {},
) =>
  apiClient
    .get<{ count: number }>("/activity/notifications/unread-count", {
      signal: options.signal,
    })
    .then((r) => r.data);

export const markNotificationRead = (id: string) =>
  apiClient.post(`/activity/notifications/${id}/read`).then((r) => r.data);

export const markAllNotificationsRead = () =>
  apiClient.post("/activity/notifications/read-all").then((r) => r.data);

/**
 * The subscriber's own notification switches.
 *
 * `available` is the list of switches the PANEL honours, and the screen
 * renders only those. A cabinet that ships ahead of the panel would otherwise
 * draw a control the panel cannot act on — which is precisely the state this
 * screen was in.
 */
export interface NotificationPreferences {
  /** Only what was actually stored; an absent key means "send it". */
  prefs: Record<string, boolean>;
  available: string[];
}

export const getNotificationPreferences = (options: ActivityRequestOptions = {}) =>
  apiClient
    .get<NotificationPreferences>("/activity/notifications/preferences", {
      signal: options.signal,
    })
    .then((r) => r.data);

export const updateNotificationPreferences = (prefs: Record<string, boolean>) =>
  apiClient
    .post<NotificationPreferences>("/activity/notifications/preferences", { prefs })
    .then((r) => r.data);
