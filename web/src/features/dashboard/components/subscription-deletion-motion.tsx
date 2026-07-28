import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import type { ResolvedSubscriptionCardVisual } from "./subscription-card-visual";
import {
  resolveSubscriptionDeletionState,
  SUBSCRIPTION_DELETION_TIMING,
  type SubscriptionDeletionServerStatus,
} from "./subscription-deletion-motion-policy";
import "./subscription-deletion-motion.css";

const DATA_TRAIL = [
  "0110  REIWA::PURGE  7F",
  "A9  001101  SLOT::CLEAR",
  "0x4D  LINK::REVOKED  10",
  "1011  CACHE::DETACH  E2",
] as const;

const PARTICLES = [
  { top: 8, size: 3, delay: -80, duration: 520, driftX: -18, driftY: -8 },
  { top: 15, size: 2, delay: -410, duration: 610, driftX: -24, driftY: 7 },
  { top: 24, size: 4, delay: -250, duration: 680, driftX: -28, driftY: -12 },
  { top: 31, size: 2, delay: -540, duration: 470, driftX: -14, driftY: 10 },
  { top: 40, size: 3, delay: -130, duration: 590, driftX: -26, driftY: -5 },
  { top: 49, size: 2, delay: -360, duration: 650, driftX: -20, driftY: 12 },
  { top: 58, size: 4, delay: -620, duration: 700, driftX: -31, driftY: -9 },
  { top: 65, size: 2, delay: -180, duration: 480, driftX: -16, driftY: 8 },
  { top: 73, size: 3, delay: -470, duration: 560, driftX: -23, driftY: -11 },
  { top: 81, size: 2, delay: -290, duration: 630, driftX: -19, driftY: 5 },
  { top: 89, size: 4, delay: -570, duration: 690, driftX: -29, driftY: -7 },
  { top: 95, size: 2, delay: -40, duration: 510, driftX: -15, driftY: -4 },
] as const;

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export interface SubscriptionDeletionMotionProps {
  readonly children: ReactNode;
  readonly active: boolean;
  readonly visual: ResolvedSubscriptionCardVisual | null;
  readonly startedAtMs: number;
  readonly serverStatus: SubscriptionDeletionServerStatus;
  readonly serverSettledAtMs: number | null;
  readonly reducedMotion: boolean;
  readonly holdingLabel: string;
  readonly successLabel: string;
  readonly handoff: boolean;
  readonly onSuccessExitComplete: () => void;
  readonly onRestoreComplete: () => void;
}

/**
 * Permanent wrapper around a real card.
 *
 * The wrapper is present before deletion starts so toggling the effect never
 * remounts SubscriptionCard or its WebGL CardEffectLayer. Only the composited
 * card surface receives a clip-path during the one-shot wipe.
 */
export function SubscriptionDeletionMotion({
  children,
  active,
  visual,
  startedAtMs,
  serverStatus,
  serverSettledAtMs,
  reducedMotion,
  holdingLabel,
  successLabel,
  handoff,
  onSuccessExitComplete,
  onRestoreComplete,
}: SubscriptionDeletionMotionProps) {
  const [, setClockTick] = useState(0);
  const completionRef = useRef<"success" | "restore" | null>(null);
  const elapsedMs = active ? Math.max(0, monotonicNow() - startedAtMs) : 0;
  const state = useMemo(
    () =>
      resolveSubscriptionDeletionState({
        elapsedMs,
        serverStatus,
        serverSettledAtMs,
        reducedMotion,
      }),
    [
      elapsedMs,
      reducedMotion,
      serverSettledAtMs,
      serverStatus,
    ],
  );

  useEffect(() => {
    if (!active || state.nextWakeAtMs === null) return;
    const remaining = Math.max(
      0,
      state.nextWakeAtMs - (monotonicNow() - startedAtMs),
    );
    const timer = window.setTimeout(
      () => setClockTick((tick) => tick + 1),
      Math.max(1, Math.ceil(remaining)),
    );
    return () => window.clearTimeout(timer);
  }, [active, startedAtMs, state.nextWakeAtMs]);

  useEffect(() => {
    if (!active) {
      completionRef.current = null;
      return;
    }
    if (state.successComplete && completionRef.current !== "success") {
      completionRef.current = "success";
      onSuccessExitComplete();
      return;
    }
    if (state.restoreComplete && completionRef.current !== "restore") {
      completionRef.current = "restore";
      onRestoreComplete();
    }
  }, [
    active,
    onRestoreComplete,
    onSuccessExitComplete,
    state.restoreComplete,
    state.successComplete,
  ]);

  const accent = visual?.primary ?? "var(--brand-primary)";
  const style = {
    "--deletion-accent": accent,
    "--deletion-core": "#ffffff",
    "--deletion-sweep-ms": `${SUBSCRIPTION_DELETION_TIMING.sweep}ms`,
    "--deletion-finish-ms": `${SUBSCRIPTION_DELETION_TIMING.finish}ms`,
    "--deletion-rollback-ms": `${SUBSCRIPTION_DELETION_TIMING.rollback}ms`,
    "--deletion-reduced-finish-ms": `${SUBSCRIPTION_DELETION_TIMING.reducedFinish}ms`,
    "--deletion-reduced-rollback-ms": `${SUBSCRIPTION_DELETION_TIMING.reducedRollback}ms`,
    "--deletion-rollback-from": `${state.rollbackFromProgress * 100}%`,
  } as CSSProperties;

  return (
    <div
      className={cn(
        "subscription-deletion-motion relative rounded-card",
        active && "subscription-deletion-motion--active",
        handoff && "subscription-deletion-motion--handoff",
      )}
      data-deletion-active={active ? "true" : undefined}
      data-deletion-mode={active ? (reducedMotion ? "reduced" : "full") : undefined}
      data-deletion-phase={active ? state.phase : undefined}
      aria-busy={active && serverStatus === "pending" ? true : undefined}
      style={style}
    >
      <div className="subscription-deletion-motion__surface">{children}</div>

      {active && (
        <>
          <div
            className="subscription-deletion-motion__effects"
            aria-hidden
          >
            <div className="subscription-deletion-motion__trail">
              {DATA_TRAIL.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
            <div className="subscription-deletion-motion__particle-field">
              {PARTICLES.map((particle, index) => (
                <i
                  key={`${particle.top}:${particle.delay}`}
                  className="subscription-deletion-motion__particle"
                  style={
                    {
                      "--particle-top": `${particle.top}%`,
                      "--particle-size": `${particle.size}px`,
                      "--particle-delay": `${particle.delay}ms`,
                      "--particle-duration": `${particle.duration}ms`,
                      "--particle-drift-x": `${particle.driftX}px`,
                      "--particle-drift-y": `${particle.driftY}px`,
                      "--particle-tone":
                        index % 4 === 0
                          ? "var(--deletion-core)"
                          : "var(--deletion-accent)",
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className="subscription-deletion-motion__beam" />
            <div className="subscription-deletion-motion__reduced-cue" />
          </div>

          {state.phase === "holding" && (
            <p
              className="subscription-deletion-motion__holding-label"
              role="status"
            >
              {holdingLabel}
            </p>
          )}

          <span className="sr-only" role="status" aria-live="polite">
            {serverStatus === "success" ? successLabel : ""}
          </span>
        </>
      )}
    </div>
  );
}
