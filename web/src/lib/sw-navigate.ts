/**
 * A push notification clicked while the cabinet is already open.
 *
 * The service worker's `notificationclick` handler (`src/sw.ts`) focuses an
 * open cabinet window and posts it `{ type: 'NAVIGATE', url }` so the SPA can
 * route without a reload. Nothing listened. So a push click with the cabinet
 * already open brought the window forward and left it on whatever page it was
 * showing — the renewal reminder did not open renewal, and the message about a
 * VPN that never connected did not open the connect page. Only a click with no
 * cabinet window at all worked, because that one opens a new window at the URL.
 *
 * ── Only a path of our own ──────────────────────────────────────────────────
 *
 * The URL comes out of a push payload, and it is handed to the router, so it
 * is held to the rule every other hop of this app applies to a destination it
 * did not build (`sanitizeNextDestination`): a same-origin absolute PATH and
 * nothing else. `https://…`, `//host/…`, `javascript:` and anything carrying a
 * backslash or a control character are dropped, not "fixed". The message must
 * also come from this origin — a service worker can only ever be same-origin,
 * but that is a claim about browsers, and checking it is one comparison.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { sanitizeNextDestination } from "@/lib/next-destination";

/** The message type `src/sw.ts` posts from `notificationclick`. */
export const SW_NAVIGATE_MESSAGE = "NAVIGATE";

/**
 * The path a service worker message asks the page to open, or `null`.
 *
 * `ownOrigin` is this document's origin (`window.location.origin`); a message
 * from any other origin, or with none at all, is ignored.
 */
export function readServiceWorkerNavigation(
  event: { readonly data?: unknown; readonly origin?: string },
  ownOrigin: string,
): string | null {
  const data = event.data;
  if (data === null || typeof data !== "object") return null;
  const message = data as { readonly type?: unknown; readonly url?: unknown };
  if (message.type !== SW_NAVIGATE_MESSAGE) return null;
  if (event.origin !== ownOrigin) return null;
  const path = sanitizeNextDestination(typeof message.url === "string" ? message.url : null);
  if (path === null) return null;
  // Belt and braces: whatever the check above let through must still resolve
  // to this origin before the router is given it.
  let resolved: URL;
  try {
    resolved = new URL(path, ownOrigin);
  } catch {
    return null;
  }
  if (resolved.origin !== ownOrigin) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * Routes the service worker's NAVIGATE through the app's router.
 *
 * Mounted once, in the protected shell: every destination a push carries is a
 * cabinet page, and a message that arrives while the customer is signed out —
 * the shell not mounted — is left alone, exactly as before this existed.
 */
export function useServiceWorkerNavigate(): void {
  const navigate = useNavigate();
  // The latest `navigate`, read when a message arrives: react-router hands down
  // a new one on every pathname, and re-registering the listener on each would
  // be churn for nothing.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const container = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
      .serviceWorker;
    // No service worker support — or a webview that exposes half of one. The
    // shell wraps every cabinet page, and a missing method must cost this
    // feature, not the page.
    if (
      container === undefined ||
      container === null ||
      typeof container.addEventListener !== "function"
    ) {
      return;
    }
    const onMessage = (event: MessageEvent): void => {
      const path = readServiceWorkerNavigation(event, window.location.origin);
      if (path === null) return;
      void navigateRef.current(path);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, []);
}
