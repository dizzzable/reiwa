/**
 * Branding namespace — public bootstrap payloads.
 *
 * `getBranding()` ships the colour-only payload (used by the payment-
 * return splash before the SPA mounts). `getReiwaPublicConfig()` is
 * the full bootstrap (branding + locales + defaultLocale) — fetched
 * once at SPA mount via React Query.
 */
import { apiClient } from "./transport.js";
import type { Branding, PublicConfig as ReiwaPublicConfig } from "@/types/branding";
import type { PublicConfig } from "@/types/api";

export const getBranding = () =>
  apiClient.get<Branding>("/branding").then((r) => r.data);

export const getReiwaPublicConfig = () =>
  apiClient.get<ReiwaPublicConfig>("/public-config").then((r) => r.data);

/**
 * Legacy `/config` payload (broader public-config, includes feature
 * flags). Distinct endpoint from `/public-config` despite the name
 * overlap.
 */
export const getPublicConfig = () =>
  apiClient.get<PublicConfig>("/config").then((r) => r.data);
