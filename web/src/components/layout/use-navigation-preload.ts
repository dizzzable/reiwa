import { useEffect } from "react";

import {
  canPreloadNavigationRoutes,
  preloadNavigationRoutes,
} from "@/components/layout/navigation-preload";

type NavigatorWithConnection = Navigator & {
  connection?: {
    readonly saveData?: boolean;
    readonly effectiveType?: string;
  };
};

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Warms the pages represented by the current navigation after the first paint.
 * The route signature is intentionally based on paths rather than the tab
 * objects: unread badges and translated labels must not restart the schedule.
 */
export function useNavigationPreload(routes: readonly string[]): void {
  const routeSignature = routes.join("\u0000");

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;

    const connection = (navigator as NavigatorWithConnection).connection;
    if (!canPreloadNavigationRoutes(connection)) return;

    const routeTargets = routeSignature ? routeSignature.split("\u0000") : [];
    const preload = () => preloadNavigationRoutes(routeTargets);
    const idleWindow = window as IdleWindow;

    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(preload, { timeout: 2_000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }

    const timeout = window.setTimeout(preload, 600);
    return () => window.clearTimeout(timeout);
  }, [routeSignature]);
}
