import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { motion, useReducedMotion } from "motion/react";

import type { Subscription } from "@/types/api";

import {
  SubscriptionCardContent,
} from "./subscription-card";
import { SubscriptionCardFrame } from "./subscription-card-frame";
import {
  SUBSCRIPTION_CREATION_TIMING,
  resolveNextSubscriptionCreationWake,
  resolveSubscriptionCreationState,
  type SubscriptionCreationStage,
} from "./subscription-card-motion-policy";
import type { ResolvedSubscriptionCardVisual } from "./subscription-card-visual";
import "./subscription-card-motion.css";

export {
  SUBSCRIPTION_CREATION_TIMING,
  resolveNextSubscriptionCreationWake,
  resolveSubscriptionCreationState,
} from "./subscription-card-motion-policy";
export type {
  ResolveNextSubscriptionCreationWakeInput,
  ResolveSubscriptionCreationStateInput,
  SubscriptionCreationStage,
  SubscriptionCreationState,
} from "./subscription-card-motion-policy";

export interface SubscriptionCreationLabels {
  readonly creating: string;
  readonly calibrating: string;
  readonly waiting: string;
  readonly longWaiting?: string;
  readonly ready: string;
  readonly failed: string;
  readonly failedHint: string;
}

export interface SubscriptionCreationMotionProps {
  readonly visual: ResolvedSubscriptionCardVisual;
  readonly backendReady: boolean;
  readonly failed?: boolean;
  readonly readySubscription?: Subscription | null;
  readonly firstDevice?: string | null;
  readonly planName: string;
  readonly labels: SubscriptionCreationLabels;
  readonly effectActive?: boolean;
  readonly longWaitAfterMs?: number;
  readonly reducedMotion?: boolean;
  readonly className?: string;
  readonly onStageChange?: (stage: SubscriptionCreationStage) => void;
  readonly onSequenceComplete?: (subscription: Subscription) => void;
}

const STAGE_RANK: Record<SubscriptionCreationStage, number> = {
  frame: 0,
  surface: 1,
  identity: 2,
  modules: 3,
  ignition: 4,
  docking: 5,
  waiting: 6,
  failed: 7,
  complete: 8,
};

function stageVisible(
  current: SubscriptionCreationStage,
  required: SubscriptionCreationStage,
): boolean {
  return STAGE_RANK[current] >= STAGE_RANK[required];
}

function motionAccentStyle(primary: string): CSSProperties {
  return {
    "--motion-accent": primary.trim() || "var(--brand-primary)",
  } as CSSProperties;
}

export function SubscriptionCreationMotion({
  visual,
  backendReady,
  failed = false,
  readySubscription = null,
  firstDevice,
  planName,
  labels,
  effectActive,
  longWaitAfterMs = 15_000,
  reducedMotion: reducedMotionOverride,
  className,
  onStageChange,
  onSequenceComplete,
}: SubscriptionCreationMotionProps) {
  const prefersReducedMotion = useReducedMotion();
  const reducedMotion =
    reducedMotionOverride ?? prefersReducedMotion ?? false;
  const startTimeRef = useRef(Date.now());
  const canHandoff =
    !failed && backendReady && readySubscription !== null;
  const [elapsedMs, setElapsedMs] = useState(0);
  const [readySinceMs, setReadySinceMs] = useState<number | null>(
    canHandoff ? 0 : null,
  );
  const completedRef = useRef(false);

  useEffect(() => {
    if (canHandoff && readySinceMs === null) {
      setReadySinceMs(Math.max(0, Date.now() - startTimeRef.current));
    }
  }, [canHandoff, readySinceMs]);

  const state = useMemo(
    () =>
      resolveSubscriptionCreationState({
        elapsedMs,
        backendReady,
        readySubscriptionAvailable: readySubscription !== null,
        failed,
        readySinceMs,
        reducedMotion,
      }),
    [
      backendReady,
      elapsedMs,
      failed,
      readySinceMs,
      readySubscription,
      reducedMotion,
    ],
  );

  const nextWakeElapsedMs = useMemo(
    () =>
      resolveNextSubscriptionCreationWake({
        elapsedMs,
        backendReady,
        readySubscriptionAvailable: readySubscription !== null,
        failed,
        readySinceMs,
        reducedMotion,
        longWaitAfterMs,
      }),
    [
      backendReady,
      elapsedMs,
      failed,
      longWaitAfterMs,
      readySinceMs,
      readySubscription,
      reducedMotion,
    ],
  );

  useEffect(() => {
    if (nextWakeElapsedMs === null) return;
    const currentElapsed = Math.max(
      0,
      Date.now() - startTimeRef.current,
    );
    const delay = Math.max(1, nextWakeElapsedMs - currentElapsed);
    const timer = window.setTimeout(() => {
      setElapsedMs(Math.max(0, Date.now() - startTimeRef.current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [nextWakeElapsedMs]);

  useEffect(() => {
    onStageChange?.(state.stage);
  }, [onStageChange, state.stage]);

  useEffect(() => {
    if (
      !state.complete ||
      readySubscription === null ||
      completedRef.current
    ) {
      return;
    }
    completedRef.current = true;
    onSequenceComplete?.(readySubscription);
  }, [onSequenceComplete, readySubscription, state.complete]);

  const surfaceVisible = stageVisible(state.stage, "surface");
  const identityVisible = stageVisible(state.stage, "identity");
  const modulesVisible = stageVisible(state.stage, "modules");
  const effectVisible = stageVisible(state.stage, "ignition");
  const showReadyContent =
    !failed && canHandoff && stageVisible(state.stage, "docking");
  const isLongWait = elapsedMs >= longWaitAfterMs;
  const statusLabel =
    failed
      ? labels.failed
      : state.stage === "ignition"
        ? labels.calibrating
        : state.stage === "waiting"
          ? isLongWait && labels.longWaiting
            ? labels.longWaiting
            : labels.waiting
          : showReadyContent
            ? labels.ready
            : labels.creating;

  const pendingContent = (
    <motion.div
      key="pending"
      aria-hidden
      className="relative flex h-full w-full flex-col justify-between"
      initial={false}
      animate={{ opacity: showReadyContent ? 0 : 1 }}
      transition={{ duration: reducedMotion ? 0.08 : 0.22 }}
    >
      <motion.div
        className="flex items-start justify-between gap-3"
        initial={false}
        animate={{
          opacity: identityVisible ? 1 : 0,
          y: reducedMotion ? 0 : identityVisible ? 0 : -8,
        }}
        transition={{ duration: reducedMotion ? 0.16 : 0.38 }}
      >
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-wide @sm:text-sm">
            {planName}
          </p>
          <div className="subscription-card-motion__module-line mt-2 h-px w-14 rounded-full opacity-70" />
        </div>
        <span className="max-w-[58%] truncate rounded-full border border-white/15 bg-black/25 px-2.5 py-1 text-[9px] font-semibold tracking-[0.08em] text-white/80 uppercase backdrop-blur-md">
          {statusLabel}
        </span>
      </motion.div>

      <motion.div
        className="my-auto space-y-2"
        initial={false}
        animate={{
          opacity: modulesVisible ? 1 : 0,
          x: reducedMotion ? 0 : modulesVisible ? 0 : -14,
        }}
        transition={{ duration: reducedMotion ? 0.16 : 0.42 }}
      >
        <p className="font-mono text-[11px] tracking-[0.16em] text-white/72 uppercase">
          {failed ? labels.failedHint : statusLabel}
        </p>
        <div className="subscription-card-motion__module-line h-1 w-[72%] rounded-full" />
      </motion.div>

      <motion.div
        className="grid grid-cols-[1.2fr_0.8fr] gap-2"
        initial={false}
        animate={{
          opacity: modulesVisible ? 1 : 0,
          y: reducedMotion ? 0 : modulesVisible ? 0 : 12,
        }}
        transition={{
          duration: reducedMotion ? 0.16 : 0.42,
          delay: reducedMotion ? 0 : 0.06,
        }}
      >
        <div className="subscription-card-motion__module rounded-xl p-2.5">
          <div className="subscription-card-motion__module-line h-1 w-12 rounded-full opacity-60" />
          <div className="mt-2 h-3 w-20 rounded bg-white/12" />
        </div>
        <div className="subscription-card-motion__module rounded-xl p-2.5">
          <div className="subscription-card-motion__module-line ml-auto h-1 w-10 rounded-full opacity-60" />
          <div className="mt-2 ml-auto h-3 w-14 rounded bg-white/12" />
        </div>
      </motion.div>
    </motion.div>
  );

  const readyContent = readySubscription ? (
    <motion.div
      key="ready"
      className="relative flex h-full w-full flex-col justify-between"
      initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
      animate={{ opacity: showReadyContent ? 1 : 0, y: 0 }}
      transition={{ duration: reducedMotion ? 0.12 : 0.34 }}
    >
      <SubscriptionCardContent
        subscription={readySubscription}
        firstDevice={firstDevice}
      />
    </motion.div>
  ) : null;

  return (
    <motion.div
      className={`subscription-card-motion ${className ?? ""}`}
      style={motionAccentStyle(visual.primary)}
      data-creation-stage={state.stage}
      initial={reducedMotion ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0.22 : 0 }}
    >
      <SubscriptionCardFrame
        visual={visual}
        effectActive={
          effectVisible ? (effectActive ?? true) : false
        }
        layerOpacity={{
          foundation: surfaceVisible ? 1 : 0,
          gradient: surfaceVisible ? 1 : 0,
          vignette: surfaceVisible ? 1 : 0,
          watermark: identityVisible ? 1 : 0,
        }}
        aria-busy={!state.complete && !failed}
        overlay={
          reducedMotion || failed ? null : (
            <>
              <motion.div
                aria-hidden
                className="subscription-card-motion__rail inset-1.5"
                initial={false}
                animate={{
                  opacity: stageVisible(state.stage, "docking") ? 0 : 1,
                  scale: surfaceVisible ? 1 : 0.975,
                }}
                transition={{ duration: 0.36 }}
              />
              {state.stage === "ignition" && (
                <motion.div
                  aria-hidden
                  className="subscription-card-motion__scan"
                  initial={{ left: "-16%", opacity: 0 }}
                  animate={{
                    left: "102%",
                    opacity: [0, 0.95, 0.95, 0],
                  }}
                  transition={{
                    duration: 0.92,
                    ease: [0.4, 0, 0.2, 1],
                  }}
                />
              )}
            </>
          )
        }
      >
        {showReadyContent ? readyContent : pendingContent}
      </SubscriptionCardFrame>
      <span className="sr-only" role="status" aria-live="polite">
        {statusLabel}
      </span>
    </motion.div>
  );
}
