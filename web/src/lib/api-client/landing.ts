/**
 * Landing namespace — the effective PUBLISHED web-landing config.
 *
 * The BFF serves either the full landing config or the `{ enabled: false }`
 * sentinel; the shape is returned untyped here and re-parsed fail-closed by the
 * renderer (`features/landing/landing-schema.ts`) so an unknown/invalid section
 * type never crashes the page.
 */
import { apiClient } from "./transport.js";
import type { EffectiveLandingPayload } from "@/features/landing/landing-schema";

export const getLanding = () =>
  apiClient.get<EffectiveLandingPayload>("/landing").then((r) => r.data);
