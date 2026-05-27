/**
 * Devices namespace — list and unbind HWIDs.
 */
import { apiClient } from "./transport.js";

export const getUserDevices = () =>
  apiClient.get("/devices").then((r) => r.data);

export const deleteUserDevice = (hwid: string) =>
  apiClient.delete(`/devices/${hwid}`).then((r) => r.data);
