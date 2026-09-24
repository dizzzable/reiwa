/**
 * Branding namespace — public bootstrap payloads.
 *
 * `getBranding()` ships the colour-only payload (used by the payment-
 * return splash before the SPA mounts). `getReiwaPublicConfig()` is
 * the full bootstrap (branding + locales + defaultLocale) — fetched
 * once at SPA mount via React Query.
 */
import { apiClient } from "./transport.js";
import {
  configVersionRequest,
  configVersionWatcher,
  servedConfigVersion,
} from "@/lib/config-versions";
import type { Branding, PublicConfig as ReiwaPublicConfig } from "@/types/branding";
import type { PublicConfig } from "@/types/api";

export const getBranding = () =>
  apiClient.get<Branding>("/branding").then((r) => r.data);

/**
 * With the version the cabinet holds once it is known (`?v=`, so no cache can
 * answer with an older copy), and noting the version the body names — a copy
 * the browser's cache answered with just after a save is then refetched at
 * once (`lib/config-versions.ts`).
 */
export const getReiwaPublicConfig = () => {
  const versioned = configVersionRequest("publicConfig");
  const request =
    versioned === undefined
      ? apiClient.get<ReiwaPublicConfig>("/public-config")
      : apiClient.get<ReiwaPublicConfig>("/public-config", versioned);
  return request.then((r) => {
    configVersionWatcher.noteServed("publicConfig", servedConfigVersion(r.headers));
    return r.data;
  });
};

/**
 * Legacy `/config` payload (broader public-config, includes feature
 * flags). Distinct endpoint from `/public-config` despite the name
 * overlap.
 */
export const getPublicConfig = () =>
  apiClient.get<PublicConfig>("/config").then((r) => r.data);
