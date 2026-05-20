/**
 * SpotlightOverlay
 * ────────────────
 * Full-screen dark overlay with a "hole" cut out around the target element.
 * The hole is animated (position + size) when the target changes between
 * onboarding steps.
 *
 * Implementation: a single `<div>` with a CSS `box-shadow` that covers the
 * entire viewport except the spotlight rect. This avoids SVG clip-path
 * complexity and works on every mobile browser including older WebKit.
 */

import { motion } from "motion/react";
import { useEffect, useState } from "react";

interface SpotlightOverlayProps {
  /** CSS selector or data-attribute of the target element to spotlight. */
  targetSelector: string | null;
  /** Extra padding around the target rect (px). */
  padding?: number;
  /** Click handler for the overlay backdrop (e.g. advance to next step). */
  onClick?: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FALLBACK_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function SpotlightOverlay({
  targetSelector,
  padding = 8,
  onClick,
}: SpotlightOverlayProps) {
  const [rect, setRect] = useState<Rect>(FALLBACK_RECT);

  useEffect(() => {
    if (!targetSelector) {
      setRect(FALLBACK_RECT);
      return;
    }
    const el = document.querySelector(targetSelector);
    if (!el) {
      setRect(FALLBACK_RECT);
      return;
    }
    const domRect = el.getBoundingClientRect();
    setRect({
      x: domRect.x - padding,
      y: domRect.y - padding,
      width: domRect.width + padding * 2,
      height: domRect.height + padding * 2,
    });
  }, [targetSelector, padding]);

  const hasTarget = rect.width > 0 && rect.height > 0;
  const borderRadius = 16;

  return (
    <motion.div
      className="fixed inset-0 z-9998"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onClick}
      aria-hidden
    >
      {/* Dark backdrop with a transparent hole via box-shadow */}
      <motion.div
        className="absolute"
        style={{
          top: rect.y,
          left: rect.x,
          width: rect.width,
          height: rect.height,
          borderRadius,
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.75)",
          pointerEvents: "none",
        }}
        animate={{
          top: rect.y,
          left: rect.x,
          width: rect.width,
          height: rect.height,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      />
      {/* Highlight ring around the target */}
      {hasTarget && (
        <motion.div
          className="absolute border-2 pointer-events-none"
          style={{
            borderColor: "var(--brand-primary)",
            borderRadius,
            top: rect.y,
            left: rect.x,
            width: rect.width,
            height: rect.height,
          }}
          animate={{
            top: rect.y,
            left: rect.x,
            width: rect.width,
            height: rect.height,
          }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        />
      )}
    </motion.div>
  );
}
