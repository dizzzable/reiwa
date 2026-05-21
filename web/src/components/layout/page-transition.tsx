/**
 * PageTransition
 * ──────────────
 * Crossfades + slight Y-translate when the route changes underneath the
 * StealthLayout. We key the inner motion node on `location.pathname` so
 * `AnimatePresence mode="wait"` triggers exit/enter on every navigation.
 *
 * The transition is intentionally subtle (opacity + 8px translate, ~180ms
 * duration). Anything more aggressive feels chatty in a tabbed mobile UI
 * where users tap between tabs frequently.
 */

import { AnimatePresence, motion } from "motion/react";
import { useLocation } from "react-router-dom";
import type { PropsWithChildren } from "react";

export function PageTransition({ children }: PropsWithChildren) {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="h-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
