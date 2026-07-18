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

import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const count = subscriptions.length;

  // Derive the active slide from the scroll position. Each slide fills the
  // track width, so the index is round(scrollLeft / trackWidth).
  const commitActiveIndex = useCallback(() => {
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

  // Commit the active card only AFTER scrolling settles — never mid-flick.
  // Updating `activeIndex` on every scroll event flipped `effectActive`, which
  // mounted/unmounted a WebGL context WHILE iOS was still animating the
  // momentum fling; that main-thread churn interrupted the fling and aborted
  // the mandatory snap, so a fast swipe froze between two cards. Debouncing to
  // the scroll-idle (plus the native `scrollend` where supported) leaves the
  // fling untouched — the dots and the animated background update once it
  // lands.
  const handleScroll = useCallback(() => {
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(commitActiveIndex, 120);
  }, [commitActiveIndex]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onScrollEnd = () => commitActiveIndex();
    el.addEventListener("scrollend", onScrollEnd);
    return () => el.removeEventListener("scrollend", onScrollEnd);
  }, [commitActiveIndex]);

  useEffect(
    () => () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    },
    [],
  );

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
        // No `scroll-smooth` here: `scroll-behavior: smooth` on a
        // scroll-snap-mandatory container makes iOS Safari abort the snap
        // animation mid-flight, leaving the carousel resting between two
        // cards. Programmatic navigation (arrows/dots) still animates via the
        // explicit `behavior: "smooth"` arg passed to `scrollTo` in `goTo`.
        // `.carousel-track` pins the scroller to a single (horizontal) axis —
        // see index.css for why a nested y-scroller broke the iOS snap.
        className="flex snap-x snap-mandatory carousel-track"
      >
        {subscriptions.map((sub, i) => (
          <CarouselSlide
            key={sub.id}
            subscription={sub}
            index={i}
            firstDevice={firstDeviceById?.[sub.id] ?? null}
            effectActive={i === activeIndex}
            onLongPress={() => setDeleteTarget(sub)}
            onDelete={() => setDeleteTarget(sub)}
            deleteLabel={t("deleteSubscription.open")}
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
  onDelete,
  deleteLabel,
}: {
  subscription: Subscription;
  index: number;
  firstDevice: string | null;
  effectActive: boolean;
  onLongPress: () => void;
  onDelete: () => void;
  deleteLabel: string;
}) {
  const longPress = useLongPress(onLongPress);
  return (
    <div
      // `snap-always` (scroll-snap-stop: always) forces iOS to land on exactly
      // one card per swipe — without it a fast flick can coast past a snap
      // point and rest half-way between two cards.
      className="relative w-full shrink-0 snap-center snap-always"
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
      <button
        type="button"
        aria-label={deleteLabel}
        title={deleteLabel}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="absolute top-4 right-5 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/80 shadow-lg backdrop-blur-md transition-colors hover:bg-red-500/80 hover:text-white focus-visible:border-red-300 focus-visible:ring-3 focus-visible:ring-red-300/60 focus-visible:outline-none"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
