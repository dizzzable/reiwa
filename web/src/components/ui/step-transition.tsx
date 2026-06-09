/**
 * StepTransition
 * ──────────────
 * Crossfade + horizontal slide between wizard steps that live under one route
 * (purchase / renewal / upgrade / add-ons). `PageTransition` only animates on
 * `location.pathname` changes, so same-route step swaps were instant. Keying an
 * `AnimatePresence` child on `stepKey` gives those flows the same polish as
 * route navigation.
 *
 * Honours `prefers-reduced-motion` (Framer Motion's `MotionConfig` at the app
 * level already gates this; the transition is subtle either way).
 */
import { AnimatePresence, motion } from "motion/react";
import type { PropsWithChildren } from "react";

export function StepTransition({
  stepKey,
  children,
}: PropsWithChildren<{ stepKey: string }>) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={stepKey}
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -12 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
