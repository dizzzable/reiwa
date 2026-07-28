import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";

import {
  SUBSCRIPTION_DELETION_REDUCED_PRESENTATION,
  SUBSCRIPTION_DELETION_TIMING,
  resolveSubscriptionDeletionDuration,
  resolveSubscriptionDeletionVisualMode,
} from "./subscription-card-motion-policy";
import type { ResolvedSubscriptionCardVisual } from "./subscription-card-visual";
import "./subscription-card-motion.css";

export {
  SUBSCRIPTION_DELETION_TIMING,
  resolveSubscriptionDeletionDuration,
} from "./subscription-card-motion-policy";

export interface SubscriptionDeletionMotionProps {
  readonly active: boolean;
  /** Frozen at delete success together with the card rendered in `children`. */
  readonly visual: Pick<ResolvedSubscriptionCardVisual, "primary">;
  readonly children: ReactNode;
  readonly durationMs?: number;
  readonly reducedMotion?: boolean;
  readonly className?: string;
  readonly onExitComplete: () => void;
}

const GLYPHS = [
  { value: "01100110", top: 4, left: 4, size: 7 },
  { value: "0x7F", top: 10, left: 51, size: 8 },
  { value: "SYNC::ACK", top: 16, left: 18, size: 7 },
  { value: "101101", top: 22, left: 66, size: 6 },
  { value: "0xC4", top: 28, left: 7, size: 8 },
  { value: "NULL", top: 34, left: 43, size: 7 },
  { value: "11001010", top: 40, left: 12, size: 6 },
  { value: "DROP", top: 46, left: 72, size: 7 },
  { value: "0b1011", top: 52, left: 31, size: 7 },
  { value: "17A3", top: 58, left: 3, size: 8 },
  { value: "001011", top: 64, left: 57, size: 6 },
  { value: "HASH", top: 70, left: 20, size: 7 },
  { value: "0x00", top: 76, left: 76, size: 7 },
  { value: "1110", top: 82, left: 39, size: 7 },
  { value: "EOF", top: 88, left: 8, size: 7 },
  { value: "01010101", top: 94, left: 54, size: 6 },
] as const;

const DUST = [
  { left: 4, top: 12, size: 2, drift: -7 },
  { left: 9, top: 78, size: 1, drift: 8 },
  { left: 16, top: 44, size: 2, drift: 12 },
  { left: 23, top: 19, size: 1, drift: -9 },
  { left: 29, top: 67, size: 2, drift: 7 },
  { left: 36, top: 89, size: 1, drift: -11 },
  { left: 42, top: 37, size: 2, drift: 10 },
  { left: 49, top: 9, size: 1, drift: -8 },
  { left: 55, top: 72, size: 2, drift: 9 },
  { left: 62, top: 53, size: 1, drift: -12 },
  { left: 68, top: 25, size: 2, drift: 8 },
  { left: 74, top: 83, size: 1, drift: -7 },
  { left: 81, top: 42, size: 2, drift: 11 },
  { left: 87, top: 15, size: 1, drift: -9 },
  { left: 93, top: 68, size: 2, drift: 7 },
] as const;

function deletionStyle(primary: string, duration: number): CSSProperties {
  return {
    "--motion-accent": primary.trim() || "var(--brand-primary)",
    "--deletion-duration": `${duration}ms`,
    "--deletion-sweep-delay": `${duration * 0.12}ms`,
    "--deletion-sweep-duration": `${duration * 0.88}ms`,
  } as CSSProperties;
}

/**
 * Explicit-success deletion wrapper. The parent keeps its real card mounted
 * until onExitComplete, then removes it from the canonical query cache.
 */
export function SubscriptionDeletionMotion({
  active,
  visual,
  children,
  durationMs,
  reducedMotion: reducedMotionOverride,
  className,
  onExitComplete,
}: SubscriptionDeletionMotionProps) {
  const reducedMotion =
    resolveSubscriptionDeletionVisualMode(reducedMotionOverride) ===
    "reduced";
  const duration = resolveSubscriptionDeletionDuration(
    reducedMotion,
    durationMs,
  );
  const reducedPresentation = SUBSCRIPTION_DELETION_REDUCED_PRESENTATION;
  const completedRef = useRef(false);
  const onExitCompleteRef = useRef(onExitComplete);

  useEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  }, [onExitComplete]);

  useEffect(() => {
    if (!active) completedRef.current = false;
  }, [active]);

  const completeOnce = (): void => {
    if (!active || completedRef.current) return;
    completedRef.current = true;
    onExitCompleteRef.current();
  };

  // Do not let the visual animation decide when to remove the card. The
  // deterministic timer guarantees that the snapshot stays mounted for the
  // complete deletion presentation before the canonical row leaves.
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(completeOnce, duration);
    return () => window.clearTimeout(timer);
  }, [active, duration]);

  return (
    <div
      className={cn(
        "subscription-card-motion relative overflow-visible",
        active && "pointer-events-none",
        active && !reducedMotion && "subscription-card-motion--deleting",
        className,
      )}
      style={deletionStyle(visual.primary, duration)}
      data-deletion-active={active ? "true" : "false"}
      data-deletion-motion={reducedMotion ? "reduced" : "full"}
    >
      {reducedMotion ? (
        <motion.div
          initial={active ? { opacity: 1, filter: "brightness(1)" } : false}
          animate={
            active
              ? {
                  opacity: [...reducedPresentation.cardOpacity],
                  filter: [...reducedPresentation.cardFilter],
                }
              : { opacity: 1, filter: "brightness(1)" }
          }
          transition={
            active
              ? {
                  duration: duration / 1_000,
                  ease: "easeOut",
                  times: [...reducedPresentation.cardTimes],
                }
              : { duration: 0 }
          }
          style={active ? { willChange: "filter, opacity" } : undefined}
        >
          {children}
        </motion.div>
      ) : (
        <div
          className={cn(active && "subscription-card-deletion__card")}
        >
          {children}
        </div>
      )}

      {active && reducedMotion && (
        <motion.div
          aria-hidden
          className="subscription-card-deletion__reduced-cue pointer-events-none absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: [...reducedPresentation.cueOpacity] }}
          transition={{
            duration: duration / 1_000,
            ease: "easeOut",
            times: [...reducedPresentation.cueTimes],
          }}
        />
      )}

      {active && !reducedMotion && (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="subscription-card-deletion__laser" />

          <div className="subscription-card-deletion__glyph-trail">
            {GLYPHS.map((glyph) => (
              <span
                key={`${glyph.value}-${glyph.top}`}
                className="subscription-card-deletion__glyph"
                style={{
                  top: `${glyph.top}%`,
                  left: `${glyph.left}%`,
                  fontSize: glyph.size,
                }}
              >
                {glyph.value}
              </span>
            ))}
          </div>

          <div className="subscription-card-deletion__boundary" />

          {DUST.map((particle, index) => {
            const delay = (particle.left / 100) * duration * 0.78;
            return (
              <span
                key={`${particle.left}-${particle.top}`}
                className="subscription-card-deletion__dust"
                style={{
                  left: `${particle.left}%`,
                  top: `${particle.top}%`,
                  "--dust-size": `${particle.size}px`,
                  "--dust-delay": `${delay}ms`,
                  "--dust-duration": `${duration * 0.13}ms`,
                  "--dust-drift-x": `${particle.drift}px`,
                  "--dust-drift-y": `${index % 2 === 0 ? -5 : 5}px`,
                } as CSSProperties}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
