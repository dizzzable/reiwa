/**
 * PageTransition
 * ──────────────
 * Crossfades + slight Y-translate when the route changes underneath the
 * StealthLayout. The incoming route mounts immediately: bottom navigation is
 * a direct destination switch, and waiting for an exit creates a visible empty
 * frame while a lazily loaded page is resolving.
 *
 * The transition is intentionally subtle (opacity + 5px translate, ~140ms
 * duration). Anything more aggressive feels chatty in a tabbed mobile UI
 * where users tap between tabs frequently.
 */

import { motion } from "motion/react";
import { useLocation } from "react-router";
import type { PropsWithChildren } from "react";

export function PageTransition({ children }: PropsWithChildren) {
  const location = useLocation();
  return (
    <motion.div
      key={location.pathname}
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}
