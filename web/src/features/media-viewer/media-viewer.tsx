import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { MediaViewerItem } from "./media-viewer-item";
import {
  classifyDrag,
  pageStepFromDrag,
  shouldDismissFromDrag,
  touchDistance,
  touchMidpoint,
  type DragIntent,
} from "./media-viewer-gestures";
import { canStep, clampIndex, stepIndex } from "./media-viewer-nav";
import {
  MIN_SCALE,
  NO_ZOOM,
  panBy,
  toggleZoom,
  zoomTo,
  type ZoomBounds,
  type ZoomState,
} from "./media-viewer-zoom";

export type { MediaViewerItem };

/** Milliseconds and pixels within which a second tap counts as a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;

/** How far a dismiss drag travels before the backdrop is fully faded. */
const DISMISS_FADE_PX = 260;

/**
 * How long after a touch a `click`/`dblclick` is treated as the engine's own
 * synthesis of that touch rather than a real mouse.
 */
const SYNTHETIC_CLICK_WINDOW_MS = 700;

/**
 * Full-screen viewer for the images and videos the cabinet shows.
 *
 * ── Why a layer and not the Fullscreen API ────────────────────────────────
 * The cabinet spends most of its life inside the Telegram mini app, where the
 * browser fullscreen request does not exist for an arbitrary element on iOS. A
 * layer sized to the viewport behaves identically on every client the cabinet
 * actually runs in, which is worth more than a native fullscreen that works on
 * one of them.
 *
 * Built on the Radix dialog primitive rather than a bare fixed div so the focus
 * trap, the Escape key, the scroll lock on the page underneath and the portal
 * all come from the same implementation the rest of the cabinet's dialogs use.
 *
 * All the arithmetic — what a drag means, where a pinch anchors, how far an
 * image may travel — lives in the three sibling modules and is tested there.
 */
export function MediaViewer({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  readonly items: readonly MediaViewerItem[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const current = clampIndex(index, items.length);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM);
  const [drag, setDrag] = useState<{ intent: DragIntent; dx: number; dy: number } | null>(null);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRefs = useRef(new Map<number, HTMLVideoElement>());
  // EVERY moving part of a gesture lives here, not in React state.
  //
  // The release path used to read the drag offset out of the render closure
  // while reading the intent out of this ref. When a `touchmove` and the
  // `touchend` that follows it land in the same turn — an ordinary flick —
  // there is no render between them, the two disagree, and the swipe is
  // silently swallowed. `dx`/`dy` below are the authoritative offsets; the
  // React state exists only to paint them.
  const gesture = useRef({
    startX: 0,
    startY: 0,
    dx: 0,
    dy: 0,
    intent: null as DragIntent | null,
    pinchDistance: 0,
    pinchScale: 1,
    lastTapAt: 0,
    lastTapX: 0,
    lastTapY: 0,
    lastTouchAt: 0,
  });

  const item = current >= 0 ? items[current] : undefined;

  // A new picture starts fitted and centred. Carrying the previous one's zoom
  // across would open the next item already magnified into a corner of an image
  // nobody has seen yet.
  //
  // Adjusted during render rather than in an effect, which is the documented
  // React pattern for state that must follow a prop — and here it is also the
  // correct one to look at: an effect resets AFTER the commit, so the next
  // picture would be painted once at the previous one's zoom and offset before
  // snapping back.
  const [zoomedFor, setZoomedFor] = useState(current);
  if (zoomedFor !== current) {
    setZoomedFor(current);
    setZoom(NO_ZOOM);
    setDrag(null);
  }

  // Anything that is not on screen stops playing. Without this, paging away
  // from a video leaves its sound running under the next picture.
  useEffect(() => {
    for (const [at, video] of videoRefs.current) {
      if (at !== current) video.pause();
    }
  }, [current]);

  const goto = useCallback(
    (delta: number) => {
      const next = stepIndex(current, items.length, delta);
      if (next !== current && next >= 0) onIndexChange(next);
    },
    [current, items.length, onIndexChange],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") goto(1);
      else if (event.key === "ArrowLeft") goto(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goto]);

  /** Viewport and rendered-image size, measured live so rotation is handled. */
  const readBounds = useCallback((): ZoomBounds => {
    const surface = surfaceRef.current;
    const image = imageRef.current;
    return {
      contentWidth: image?.clientWidth ?? 0,
      contentHeight: image?.clientHeight ?? 0,
      viewportWidth: surface?.clientWidth ?? 0,
      viewportHeight: surface?.clientHeight ?? 0,
    };
  }, []);

  /** Viewport coordinates relative to its centre — what the zoom module wants. */
  const toFocus = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - (rect.left + rect.width / 2),
      y: clientY - (rect.top + rect.height / 2),
    };
  }, []);

  /**
   * Starts a fresh gesture from whatever fingers are on the glass right now.
   *
   * Called on every touch START and on every touch END that leaves a finger
   * behind. That second call is the fix for a whole family of defects: the
   * origin used to survive a change in finger count, so lifting one finger
   * after a pinch left the surviving finger measuring its movement from where
   * some other finger began — a 5 px nudge threw the picture 45 px, and a pinch
   * whose two fingers landed together (the normal way people pinch) measured
   * from an origin of 0,0 and slammed the image into a corner. It also left
   * `intent` stuck on "PAN", so paging and dismissing were dead until every
   * finger left the glass.
   */
  const beginGesture = (touches: readonly React.Touch[]) => {
    const g = gesture.current;
    g.dx = 0;
    g.dy = 0;
    g.intent = null;
    g.pinchDistance = 0;
    const first = touches[0];
    if (first) {
      g.startX = first.clientX;
      g.startY = first.clientY;
    }
    if (touches.length === 2) {
      g.intent = "PAN";
      g.pinchDistance = touchDistance(touches);
      g.pinchScale = zoom.scale;
    }
  };

  const onTouchStart = (event: React.TouchEvent) => {
    gesture.current.lastTouchAt = event.timeStamp;
    beginGesture(Array.from(event.touches));
    setDrag(null);
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const touches = Array.from(event.touches);
    const g = gesture.current;

    if (touches.length === 2 && g.pinchDistance > 0) {
      const distance = touchDistance(touches);
      if (distance <= 0) return;
      const mid = touchMidpoint(touches);
      const focus = toFocus(mid.x, mid.y);
      const bounds = readBounds();
      setZoom((prev) => zoomTo(prev, (g.pinchScale * distance) / g.pinchDistance, focus, bounds));
      return;
    }

    const touch = touches[0];
    if (!touch || touches.length !== 1) return;
    const dx = touch.clientX - g.startX;
    const dy = touch.clientY - g.startY;

    if (g.intent === null) {
      g.intent = classifyDrag({ scale: zoom.scale, dx, dy });
      if (g.intent === null) return;
    }

    if (g.intent === "PAN") {
      // Panning consumes the movement, so the origin follows the finger and the
      // next move reports a delta rather than the total travel.
      g.startX = touch.clientX;
      g.startY = touch.clientY;
      const bounds = readBounds();
      setZoom((prev) => panBy(prev, dx, dy, bounds));
      return;
    }
    g.dx = dx;
    g.dy = dy;
    setDrag({ intent: g.intent, dx, dy });
  };

  const onTouchEnd = (event: React.TouchEvent) => {
    const g = gesture.current;
    g.lastTouchAt = event.timeStamp;

    // Fingers left on the glass mean the gesture changed shape rather than
    // ended — start a new one from what remains instead of waiting for the
    // hand to leave, which is what used to strand the state machine.
    if (event.touches.length > 0) {
      beginGesture(Array.from(event.touches));
      setDrag(null);
      return;
    }

    const released = event.changedTouches[0];
    // The release point off the event beats both the ref's last move and the
    // render closure: it is where the finger actually left, so a swipe that
    // crosses the threshold on its final move still counts.
    const dx = released ? released.clientX - g.startX : g.dx;
    const dy = released ? released.clientY - g.startY : g.dy;
    const intent = g.intent;
    g.intent = null;
    g.pinchDistance = 0;
    g.dx = 0;
    g.dy = 0;
    setDrag(null);

    if (intent === "PAGE") {
      goto(pageStepFromDrag({ dx, viewportWidth: readBounds().viewportWidth }));
      return;
    }
    if (intent === "DISMISS") {
      if (shouldDismissFromDrag({ dy })) onClose();
      return;
    }
    if (intent !== null) return;

    // No intent means the finger never travelled: this was a tap.
    const touch = released;
    if (!touch || item?.kind !== "image") return;
    const now = event.timeStamp;
    const isDouble =
      now - g.lastTapAt < DOUBLE_TAP_MS &&
      Math.hypot(touch.clientX - g.lastTapX, touch.clientY - g.lastTapY) < DOUBLE_TAP_SLOP_PX;
    g.lastTapAt = isDouble ? 0 : now;
    g.lastTapX = touch.clientX;
    g.lastTapY = touch.clientY;
    if (isDouble) {
      const focus = toFocus(touch.clientX, touch.clientY);
      const bounds = readBounds();
      setZoom((prev) => toggleZoom(prev, focus, bounds));
    }
  };

  /**
   * Double click, for a mouse.
   *
   * Ignored right after a touch. `touch-action: none` switches off the
   * browser's own double-tap-to-zoom, and that is exactly the condition under
   * which the engine still synthesises a `dblclick` from a double tap — so the
   * touch path zoomed in and this handler immediately toggled it back out,
   * making the gesture look like it did nothing at all.
   */
  const onDoubleClick = (event: React.MouseEvent) => {
    if (event.timeStamp - gesture.current.lastTouchAt < SYNTHETIC_CLICK_WINDOW_MS) return;
    if (item?.kind !== "image") return;
    const focus = toFocus(event.clientX, event.clientY);
    const bounds = readBounds();
    setZoom((prev) => toggleZoom(prev, focus, bounds));
  };

  const trackStyle = useMemo(() => {
    const offset = drag?.intent === "PAGE" ? drag.dx : 0;
    return {
      transform: "translate3d(calc(" + -current * 100 + "% + " + offset + "px), 0, 0)",
      transition: drag ? "none" : "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
    };
  }, [current, drag]);

  const dismissProgress =
    drag?.intent === "DISMISS" ? Math.min(1, Math.max(0, drag.dy) / DISMISS_FADE_PX) : 0;

  if (!item) return null;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[60] bg-black/90"
          style={{ opacity: 1 - dismissProgress * 0.6 }}
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[60] flex flex-col outline-none select-none"
          // The viewer IS the picture; a description would be read out over it.
          aria-describedby={undefined}
          // Radix restores focus to the thumbnail on close, which is right, but
          // it also scrolls it into view — and the caller may have unmounted it.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">{item.label}</DialogPrimitive.Title>

          <div className="relative z-10 flex shrink-0 items-center justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <span className="min-w-0 flex-1 truncate text-xs text-white/70">{item.label}</span>
            {items.length > 1 && (
              <span className="shrink-0 text-xs tabular-nums text-white/70">
                {t("mediaViewer.counter", { current: current + 1, total: items.length })}
              </span>
            )}
            <DialogPrimitive.Close
              aria-label={t("mediaViewer.close")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          <div
            ref={surfaceRef}
            className="relative min-h-0 flex-1 overflow-hidden"
            style={{
              // The browser must not claim these gestures: we are the ones
              // panning, pinching and paging inside this box.
              touchAction: "none",
              transform: dismissProgress > 0 ? "translate3d(0, " + (drag?.dy ?? 0) + "px, 0)" : undefined,
            }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
            onDoubleClick={onDoubleClick}
          >
            <div className="flex h-full w-full" style={trackStyle}>
              {items.map((entry, at) => (
                <div
                  key={entry.url + "@" + at}
                  className="flex h-full w-full shrink-0 items-center justify-center p-2"
                >
                  {entry.kind === "image" ? (
                    <img
                      ref={at === current ? imageRef : undefined}
                      src={entry.url}
                      alt={entry.label}
                      draggable={false}
                      loading={at === current ? "eager" : "lazy"}
                      decoding="async"
                      className="max-h-full max-w-full object-contain"
                      style={
                        at === current
                          ? {
                              transform:
                                "translate3d(" +
                                zoom.x +
                                "px, " +
                                zoom.y +
                                "px, 0) scale(" +
                                zoom.scale +
                                ")",
                              transition: drag || zoom.scale !== MIN_SCALE ? "none" : undefined,
                            }
                          : undefined
                      }
                    />
                  ) : (
                    <video
                      ref={(element) => {
                        if (element) videoRefs.current.set(at, element);
                        else videoRefs.current.delete(at);
                      }}
                      src={entry.url}
                      aria-label={entry.label}
                      controls={at === current}
                      playsInline
                      // Only the visible video is worth bytes: a FAQ answer with
                      // three clips must not fetch all three to show one.
                      preload={at === current ? "metadata" : "none"}
                      className="max-h-full max-w-full bg-black object-contain"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {items.length > 1 && (
            <>
              <ViewerArrow
                side="left"
                disabled={!canStep(current, items.length, -1)}
                label={t("mediaViewer.previous")}
                onClick={() => goto(-1)}
              />
              <ViewerArrow
                side="right"
                disabled={!canStep(current, items.length, 1)}
                label={t("mediaViewer.next")}
                onClick={() => goto(1)}
              />
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ViewerArrow({
  side,
  disabled,
  label,
  onClick,
}: {
  readonly side: "left" | "right";
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
}): React.JSX.Element {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // Hidden on touch widths, where the swipe is the control and a pair of
        // arrows would only sit on top of the picture.
        "absolute top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-opacity hover:bg-white/20 sm:flex",
        side === "left" ? "left-3" : "right-3",
        disabled && "pointer-events-none opacity-25",
      )}
    >
      <Icon className="h-6 w-6" />
    </button>
  );
}
