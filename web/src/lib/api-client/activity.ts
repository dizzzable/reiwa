/**
 * Activity namespace — transactions ledger + notifications inbox.
 */
import { apiClient } from "./transport.js";
import type { NotificationsResponse, TransactionsResponse } from "@/types/api";

export const getTransactions = (page = 1, limit = 20) =>
  apiClient
    .get<TransactionsResponse>("/activity/transactions", {
      params: { page, limit },
    })
    .then((r) => r.data);

export const getNotifications = (page = 1, limit = 20) =>
  apiClient
    .get<NotificationsResponse>("/activity/notifications", {
      params: { page, limit },
    })
    .then((r) => r.data);

export const getUnreadCount = () =>
  apiClient
    .get<{ count: number }>("/activity/notifications/unread-count")
    .then((r) => r.data);

export const markNotificationRead = (id: string) =>
  apiClient.post(`/activity/notifications/${id}/read`).then((r) => r.data);

export const markAllNotificationsRead = () =>
  apiClient.post("/activity/notifications/read-all").then((r) => r.data);
