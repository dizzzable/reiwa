/**
 * SubscriptionCarousel
 * ────────────────────
 * Horizontal swipeable carousel of subscription cards. Uses Framer Motion
 * drag with physics-based spring for natural feel on touch devices.
 *
 * Features:
 *   - Swipe left/right to switch between subscriptions.
 *   - Pagination dots below the card.
 *   - Edge arrows (< >) for desktop / accessibility.
 *   - Snaps to the nearest card on release.
 */

import { motion, useMotionValue, useTransform, animate } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Subscription } from "@/types/api";
import { SubscriptionCard } from "./subscription-card";

interface SubscriptionCarouselProps {
  subscriptions: Subscription[];
}

export function SubscriptionCarousel({ subscriptions }: SubscriptionCarouselProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);

  const count = subscriptions.length;
  const cardWidth = 320; // px — matches the max-w of the card
  const gap = 16;

  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, count - 1));
      setActiveIndex(clamped);
      animate(x, -(clamped * (cardWidth + gap)), {
        type: "spring",
        stiffness: 300,
        damping: 30,
      });
    },
    [count, x],
  );

  const handleDragEnd = useCallback(
    (_: unknown, info: { offset: { x: number }; velocity: { x: number } }) => {
      const threshold = cardWidth / 4;
      const velocityThreshold = 200;
      let newIndex = activeIndex;

      if (info.offset.x < -threshold || info.velocity.x < -velocityThreshold) {
        newIndex = activeIndex + 1;
      } else if (info.offset.x > threshold || info.velocity.x > velocityThreshold) {
        newIndex = activeIndex - 1;
      }
      goTo(newIndex);
    },
    [activeIndex, goTo],
  );

  if (count === 0) return null;

  return (
    <div className="relative px-5">
      {/* Carousel track */}
      <div ref={containerRef} className="overflow-hidden">
        <motion.div
          className="flex cursor-grab active:cursor-grabbing"
          style={{ x, gap: `${gap}px` }}
          drag={count > 1 ? "x" : false}
          dragConstraints={{
            left: -((count - 1) * (cardWidth + gap)),
            right: 0,
          }}
          dragElastic={0.1}
          onDragEnd={handleDragEnd}
        >
          {subscriptions.map((sub) => (
            <div
              key={sub.id}
              className="shrink-0"
              style={{ width: `${cardWidth}px` }}
            >
              <SubscriptionCard subscription={sub} />
            </div>
          ))}
        </motion.div>
      </div>

      {/* Edge arrows (only when multiple cards) */}
      {count > 1 && (
        <>
          {activeIndex > 0 && (
            <button
              onClick={() => goTo(activeIndex - 1)}
              className="absolute left-1 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-sm hover:bg-black/70 transition-colors"
              aria-label="Previous subscription"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {activeIndex < count - 1 && (
            <button
              onClick={() => goTo(activeIndex + 1)}
              className="absolute right-1 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-sm hover:bg-black/70 transition-colors"
              aria-label="Next subscription"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </>
      )}

      {/* Pagination dots */}
      {count > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1.5">
          {subscriptions.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              aria-label={`Subscription ${i + 1}`}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                i === activeIndex
                  ? "w-4 bg-(--brand-primary)"
                  : "w-1.5 bg-white/20 hover:bg-white/40"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
