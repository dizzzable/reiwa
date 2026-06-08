/**
 * SubscriptionCarousel
 * ────────────────────
 * Horizontal, swipeable carousel of subscription cards built on native CSS
 * scroll-snap. Each slide is exactly the width of the carousel viewport, so
 * one card is always shown edge-to-edge with the page gutter — it never
 * overflows or clips regardless of device width (the previous fixed-320px
 * implementation bled off-screen on narrow phones).
 *
 * Features:
 *   - Native touch swipe with mandatory snap (no JS drag math).
 *   - Pagination dots reflect the active slide (derived from scroll position).
 *   - Edge arrows for desktop / accessibility.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Subscription } from "@/types/api";
import { useLongPress } from "@/hooks/use-long-press";
import { SubscriptionCard } from "./subscription-card";
import { DeleteSubscriptionDialog } from "./delete-subscription-dialog";

interface SubscriptionCarouselProps {
  subscriptions: Subscription[];
  /**
   * Name of the connected device shown on a card face. Keyed by subscription
   * id so each card shows its own device (the devices query is scoped to the
   * active subscription).
   */
  firstDeviceById?: Record<string, string | null>;
  /** Notifies the parent when the visible (active) card changes. */
  onActiveIndexChange?: (index: number) => void;
}

export function SubscriptionCarousel({
  subscriptions,
  firstDeviceById,
  onActiveIndexChange,
}: SubscriptionCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const count = subscriptions.length;

  // Derive the active slide from the scroll position. Each slide fills the
  // track width, so the index is round(scrollLeft / trackWidth).
  const handleScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const width = el.clientWidth || 1;
    const index = Math.round(el.scrollLeft / width);
    setActiveIndex((prev) => {
      if (prev === index) return prev;
      onActiveIndexChange?.(index);
      return index;
    });
  }, [onActiveIndexChange]);

  const goTo = useCallback((index: number) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(index, el.children.length - 1));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
  }, []);

  // Keep the active index sane if the subscription count shrinks.
  useEffect(() => {
    if (activeIndex > count - 1) setActiveIndex(Math.max(0, count - 1));
  }, [count, activeIndex]);

  if (count === 0) return null;

  return (
    <div className="relative">
      {/* Snap scroller — full-width slides; gutter lives on each slide so the
          card never touches the screen edge and snapping stays centered. */}
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth scroll-area"
      >
        {subscriptions.map((sub, i) => (
          <CarouselSlide
            key={sub.id}
            subscription={sub}
            index={i}
            firstDevice={firstDeviceById?.[sub.id] ?? null}
            effectActive={Math.abs(i - activeIndex) <= 1}
            onLongPress={() => setDeleteTarget(sub)}
          />
        ))}
      </div>

      {/* Edge arrows (only when multiple cards) */}
      {count > 1 && (
        <>
          {activeIndex > 0 && (
            <button
              onClick={() => goTo(activeIndex - 1)}
              className="absolute left-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 sm:flex"
              aria-label="Previous subscription"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {activeIndex < count - 1 && (
            <button
              onClick={() => goTo(activeIndex + 1)}
              className="absolute right-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 sm:flex"
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

      <DeleteSubscriptionDialog
        subscription={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      />
    </div>
  );
}

/**
 * One carousel slide. Wraps the card with a long-press gesture that opens the
 * delete confirmation. Long-press is per-slide, so the hook lives here (it
 * cannot be called inside the parent's map).
 */
function CarouselSlide({
  subscription,
  index,
  firstDevice,
  effectActive,
  onLongPress,
}: {
  subscription: Subscription;
  index: number;
  firstDevice: string | null;
  effectActive: boolean;
  onLongPress: () => void;
}) {
  const longPress = useLongPress(onLongPress);
  return (
    <div
      className="w-full shrink-0 snap-center"
      style={{
        paddingLeft: "1.25rem",
        paddingRight: "1.25rem",
        boxSizing: "border-box",
        WebkitTouchCallout: "none",
      }}
      {...longPress}
    >
      <SubscriptionCard
        subscription={subscription}
        index={index}
        firstDevice={firstDevice}
        effectActive={effectActive}
      />
    </div>
  );
}
