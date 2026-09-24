/**
 * Landing namespace — the effective PUBLISHED web-landing config.
 *
 * The BFF serves either the full landing config or the `{ enabled: false }`
 * sentinel; the shape is returned untyped here and re-parsed fail-closed by the
 * renderer (`features/landing/landing-schema.ts`) so an unknown/invalid section
 * type never crashes the page.
 */
import { apiClient } from "./transport.js";
import { configVersionRequest } from "@/lib/config-versions";
import type { EffectiveLandingPayload } from "@/features/landing/landing-schema";

/**
 * With the version the cabinet holds once it is known (`?v=`): the service
 * worker keeps `/landing` for a day and the browser a minute, and neither may
 * answer a read the version watcher asked for (`lib/config-versions.ts`).
 */
export const getLanding = () => {
  const versioned = configVersionRequest("landing");
  return (
    versioned === undefined
      ? apiClient.get<EffectiveLandingPayload>("/landing")
      : apiClient.get<EffectiveLandingPayload>("/landing", versioned)
  ).then((r) => r.data);
};
