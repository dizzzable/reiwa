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

/**
 * Persists the onboarding-tour state server-side. `completed=true` marks the
 * tour finished/skipped; `false` resets it (so "replay tutorial" re-triggers).
 */
export const setOnboardingCompleted = (completed: boolean) =>
  apiClient.patch("/session/onboarding", { completed }).then((r) => r.data);

/**
 * Reports which surface the cabinet is running on (tma/pwa/browser) plus form
 * factor + os, once per session. The BFF upgrades installed-PWA sessions to the
 * 30-day window and records the surface for analytics. Best-effort.
 */
export const reportSurface = (input: {
  surface: "tma" | "pwa" | "browser";
  formFactor: "mobile" | "tablet" | "desktop";
  os: "ios" | "android" | "windows" | "macos" | "linux" | "other";
}) => apiClient.post("/surface/seen", input).then((r) => r.data);

export const getPlatformPolicy = () =>
  apiClient.get<PlatformPolicy>("/platform-policy").then((r) => r.data);
