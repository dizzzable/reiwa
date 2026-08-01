/**
 * Main destinations are code-split so an unused section does not inflate the
 * initial Mini App bundle. Once the cabinet is idle, we warm only the tabs an
 * operator actually exposed. This keeps the first intentional tab switch
 * instant without spending a user's constrained connection up front.
 */

type RoutePreloader = () => Promise<unknown>;

export interface ConnectionHints {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

const routePreloaders: Readonly<Record<string, RoutePreloader>> = {
  "/dashboard": () => import("@/features/dashboard/dashboard-page"),
  "/subscription/devices": () =>
    import("@/features/subscription/devices-page"),
  "/partner": () => import("@/features/partner/partner-page"),
  "/plans": () => import("@/features/plans/plans-page"),
  "/activity": () => import("@/features/activity/activity-page"),
  "/promo": () => import("@/features/promo/promo-page"),
  "/referrals": () => import("@/features/referrals/referrals-page"),
  "/settings": () => import("@/features/settings/settings-page"),
  "/settings/faq": () => import("@/features/settings/faq-page"),
  "/support": () => import("@/features/support/support-page"),
};

const pendingPreloads = new Map<string, Promise<void>>();

/** Do not prefetch optional UI on a connection where the user opted out. */
export function canPreloadNavigationRoutes(
  connection?: ConnectionHints,
): boolean {
  if (connection?.saveData) return false;
  return connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

export function isNavigationRoutePreloadable(route: string): boolean {
  return route in routePreloaders;
}

/**
 * Starts one idempotent background preload. Import failures stay retryable:
 * navigation still uses React.lazy's normal error handling if a later retry
 * cannot retrieve the chunk.
 */
export function preloadNavigationRoute(route: string): void {
  const load = routePreloaders[route];
  if (!load || pendingPreloads.has(route)) return;

  const pending = load()
    .then(() => undefined)
    .catch(() => {
      pendingPreloads.delete(route);
    });
  pendingPreloads.set(route, pending);
}

export function preloadNavigationRoutes(routes: readonly string[]): void {
  for (const route of routes) preloadNavigationRoute(route);
}
