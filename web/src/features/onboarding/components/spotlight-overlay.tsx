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

function rectsEqual(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

export function SpotlightOverlay({
  targetSelector,
  padding = 8,
  onClick,
}: SpotlightOverlayProps) {
  const [rect, setRect] = useState<Rect>(FALLBACK_RECT);

  // Continuously track the target's position via a requestAnimationFrame
  // loop. Measuring only once (on step change) left the highlight stale when
  // the dashboard reflowed after mount — subscription data loads async, the
  // web-font swaps, and the safe-area header settles, all of which shift the
  // target down a few dozen pixels *after* the first measurement. The loop is
  // cheap (a getBoundingClientRect + a guarded setState) and guarantees the
  // ring always sits exactly on the live element, including during scroll.
  useEffect(() => {
    if (!targetSelector) {
      setRect(FALLBACK_RECT);
      return;
    }

    let frame = 0;
    const measure = () => {
      const el = document.querySelector(targetSelector);
      if (el) {
        const domRect = el.getBoundingClientRect();
        const next: Rect = {
          x: domRect.x - padding,
          y: domRect.y - padding,
          width: domRect.width + padding * 2,
          height: domRect.height + padding * 2,
        };
        setRect((prev) => (rectsEqual(prev, next) ? prev : next));
      } else {
        setRect((prev) => (rectsEqual(prev, FALLBACK_RECT) ? prev : FALLBACK_RECT));
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);

    return () => cancelAnimationFrame(frame);
  }, [targetSelector, padding]);

  const hasTarget = rect.width > 0 && rect.height > 0;
  const borderRadius = 16;

  return (
    <motion.div
      className="fixed inset-0 z-[9998]"
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
