/**
 * Main destinations are code-split so an unused section does not inflate the
 * initial Mini App bundle. A destination starts downloading only on explicit
 * user intent (pointer/focus), never from a post-mount timer: bulk parsing in
 * the background visibly delayed taps on lower-powered phones.
 */

type RoutePreloader = () => Promise<unknown>;

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
