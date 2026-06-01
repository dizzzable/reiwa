/**
 * Devices namespace — list and unbind HWIDs.
 *
 * The per-subscription variants are the canonical ones used by the dashboard:
 * the device list is scoped to the currently selected subscription card, and
 * revoke/regenerate act only on that subscription's Remnawave profile.
 */
import { apiClient } from "./transport.js";

export const getUserDevices = () =>
  apiClient.get("/devices").then((r) => r.data);

export const deleteUserDevice = (hwid: string) =>
  apiClient.delete(`/devices/${hwid}`).then((r) => r.data);

/** Lists HWID devices bound to a specific subscription. */
export const getSubscriptionDevices = (subscriptionId: string) =>
  apiClient
    .get(`/devices/subscription/${encodeURIComponent(subscriptionId)}`)
    .then((r) => r.data);

/** Revokes a single HWID device from a specific subscription. */
export const deleteSubscriptionDevice = (subscriptionId: string, hwid: string) =>
  apiClient
    .delete(
      `/devices/subscription/${encodeURIComponent(subscriptionId)}/${encodeURIComponent(hwid)}`,
    )
    .then((r) => r.data);

/**
 * Regenerates the subscription link for a specific subscription. Returns
 * `{ regenerated, url }` with the fresh subscription URL.
 */
export const regenerateSubscriptionLink = (subscriptionId: string) =>
  apiClient
    .post(`/devices/subscription/${encodeURIComponent(subscriptionId)}/regenerate`)
    .then((r) => r.data as { regenerated: boolean; url: string | null });
