/**
 * PageTransition
 * ──────────────
 * Holds route content underneath the StealthLayout without adding a route
 * animation. Bottom navigation is a direct destination switch: even a short
 * fade makes the newly selected tab look delayed, especially on phones.
 *
 * Page-specific interactions still animate in their own components. Keeping
 * the shell synchronous makes the navigation response immediate and avoids a
 * transient blank state between lazily loaded destinations.
 */

import type { PropsWithChildren } from "react";

export function PageTransition({ children }: PropsWithChildren) {
  return <div className="h-full">{children}</div>;
}
