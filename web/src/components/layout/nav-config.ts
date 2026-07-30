import {
  NAV_DESTINATIONS,
  type NavDestinationId,
  type NavItemSetting,
} from "../../types/branding";

/** Fallback navigation for legacy branding payloads. */
export const DEFAULT_NAV: readonly NavItemSetting[] = [
  { id: "subscriptions", visible: true },
  { id: "referrals", visible: true },
  { id: "settings", visible: true },
];

export const DEVICE_NAV_ROUTE = "/subscription/devices";

/**
 * Runtime defence for persisted/forward-versioned navigation payloads.
 * Unknown ids and duplicates are ignored, essentials are restored, and the
 * bottom bar is capped at five visible destinations.
 */
export function normalizeNavItems(
  input: readonly NavItemSetting[],
): readonly NavItemSetting[] {
  const allowed = new Set<string>(NAV_DESTINATIONS);
  const seen = new Set<NavDestinationId>();
  const normalized: NavItemSetting[] = [];

  for (const candidate of input as ReadonlyArray<{
    readonly id: string;
    readonly visible: boolean;
  }>) {
    if (!allowed.has(candidate.id) || seen.has(candidate.id as NavDestinationId)) continue;
    const id = candidate.id as NavDestinationId;
    seen.add(id);
    normalized.push({ id, visible: candidate.visible === true });
  }

  if (!seen.has("subscriptions")) {
    normalized.unshift({ id: "subscriptions", visible: true });
  }
  if (!seen.has("settings")) {
    normalized.push({ id: "settings", visible: true });
  }

  const visibleOptional = normalized
    .filter(
      (item) =>
        item.visible && item.id !== "subscriptions" && item.id !== "settings",
    )
    .slice(0, 3)
    .map((item) => item.id);
  const allowedVisible = new Set<NavDestinationId>([
    "subscriptions",
    ...visibleOptional,
    "settings",
  ]);

  return normalized.map((item) => ({
    ...item,
    visible:
      item.id === "subscriptions" ||
      item.id === "settings" ||
      (item.visible && allowedVisible.has(item.id)),
  }));
}
