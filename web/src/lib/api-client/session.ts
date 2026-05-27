/**
 * Session + platform-policy namespace.
 *
 * `getSession()` is the React-Query bootstrap key consumed by every
 * page that needs the logged-in user. `acceptRules()` is the one-shot
 * mutation behind the rules-acceptance modal.
 */
import { apiClient } from "./transport.js";
import type { PlatformPolicy, ReiwaSession } from "@/types/api";

export const getSession = () =>
  apiClient.get<ReiwaSession>("/session").then((r) => r.data);

export const acceptRules = () =>
  apiClient.patch("/session/rules-acceptance").then((r) => r.data);

export const getPlatformPolicy = () =>
  apiClient.get<PlatformPolicy>("/platform-policy").then((r) => r.data);
