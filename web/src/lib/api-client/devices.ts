/**
 * Devices namespace — list and unbind HWIDs.
 *
 * The per-subscription variants are the canonical ones used by the dashboard:
 * the device list is scoped to the currently selected subscription card, and
 * revoke/regenerate act only on that subscription's Remnawave profile.
 */
import { apiClient } from "./transport.js";
import type { DevicesResponse } from "@/types/api";

/**
 * Both readers are typed `Promise<DevicesResponse>` and both REJECT on a
 * failed read — the BFF answers 503/502 rather than a fake empty list, so
 * callers must branch on the query's error state instead of `?? []`.
 */
export const getUserDevices = (): Promise<DevicesResponse> =>
  apiClient.get<DevicesResponse>("/devices").then((r) => r.data);

export const deleteUserDevice = (hwid: string) =>
  apiClient.delete(`/devices/${hwid}`).then((r) => r.data);

/** Lists HWID devices bound to a specific subscription. */
export const getSubscriptionDevices = (
  subscriptionId: string,
): Promise<DevicesResponse> =>
  apiClient
    .get<DevicesResponse>(`/devices/subscription/${encodeURIComponent(subscriptionId)}`)
    .then((r) => r.data);

/** Revokes a single HWID device from a specific subscription. */
export const deleteSubscriptionDevice = (subscriptionId: string, hwid: string) =>
  apiClient
    .delete(
      `/devices/subscription/${encodeURIComponent(subscriptionId)}/${encodeURIComponent(hwid)}`,
    )
    .then((r) => r.data);

/** What the admin panel reports back from a subscription-link rotation. */
export interface RegenerateSubscriptionResult {
  regenerated: boolean;
  url: string | null;
  /**
   * Whether the bound devices were actually wiped — TWO OUTCOMES, NOT ONE.
   *
   * The admin panel rotates and persists the link FIRST, then clears the
   * devices; that second step is deliberately non-fatal, because the link
   * already works by then and failing the whole call would push the customer
   * into re-rotating a link that is fine. So `regenerated: true` with
   * `devicesCleared: false` is a real, successful response meaning "new link,
   * old devices still bound". A caller that ignores this field tells the
   * customer to reconnect devices that were never disconnected.
   *
   * OPTIONAL because the BFF falls back to `{ regenerated: true }` when the
   * admin client is not configured; absent is therefore read as "no failure
   * reported", the same as `true`. Only an explicit `false` is the bad case.
   */
  devicesCleared?: boolean;
}

/**
 * Regenerates the subscription link for a specific subscription. Returns
 * `{ regenerated, url, devicesCleared }` — see the interface: a successful
 * rotation does NOT guarantee the device wipe ran.
 */
export const regenerateSubscriptionLink = (
  subscriptionId: string,
): Promise<RegenerateSubscriptionResult> =>
  apiClient
    .post(`/devices/subscription/${encodeURIComponent(subscriptionId)}/regenerate`)
    .then((r) => r.data as RegenerateSubscriptionResult);
