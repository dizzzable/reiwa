export const SUBSCRIPTION_CREATION_TIMING = {
  surface: 600,
  identity: 1_400,
  modules: 2_400,
  ignition: 3_600,
  docking: 4_800,
  waiting: 5_600,
  lateReadyHandoff: 900,
  reducedHandoff: 160,
} as const;

export type SubscriptionCreationStage =
  | "frame"
  | "surface"
  | "identity"
  | "modules"
  | "ignition"
  | "docking"
  | "waiting"
  | "failed"
  | "complete";

export interface SubscriptionCreationState {
  readonly stage: SubscriptionCreationStage;
  readonly virtualElapsedMs: number;
  readonly complete: boolean;
}

export interface ResolveSubscriptionCreationStateInput {
  readonly elapsedMs: number;
  readonly backendReady: boolean;
  readonly readySubscriptionAvailable: boolean;
  readonly failed?: boolean;
  readonly readySinceMs?: number | null;
  readonly reducedMotion?: boolean;
}

export interface ResolveNextSubscriptionCreationWakeInput
  extends ResolveSubscriptionCreationStateInput {
  readonly longWaitAfterMs: number;
}

const CREATION_STAGE_BOUNDARIES = [
  SUBSCRIPTION_CREATION_TIMING.surface,
  SUBSCRIPTION_CREATION_TIMING.identity,
  SUBSCRIPTION_CREATION_TIMING.modules,
  SUBSCRIPTION_CREATION_TIMING.ignition,
  SUBSCRIPTION_CREATION_TIMING.docking,
  SUBSCRIPTION_CREATION_TIMING.waiting,
] as const;

function stageAt(elapsedMs: number): SubscriptionCreationStage {
  if (elapsedMs < SUBSCRIPTION_CREATION_TIMING.surface) return "frame";
  if (elapsedMs < SUBSCRIPTION_CREATION_TIMING.identity) return "surface";
  if (elapsedMs < SUBSCRIPTION_CREATION_TIMING.modules) return "identity";
  if (elapsedMs < SUBSCRIPTION_CREATION_TIMING.ignition) return "modules";
  if (elapsedMs < SUBSCRIPTION_CREATION_TIMING.docking) return "ignition";
  if (elapsedMs < SUBSCRIPTION_CREATION_TIMING.waiting) return "docking";
  return "waiting";
}

/**
 * Data-driven creation timeline. A ready backend alone is insufficient: the
 * real list item must also be present before the handoff can complete.
 */
export function resolveSubscriptionCreationState({
  elapsedMs,
  backendReady,
  readySubscriptionAvailable,
  failed = false,
  readySinceMs,
  reducedMotion = false,
}: ResolveSubscriptionCreationStateInput): SubscriptionCreationState {
  const elapsed = Math.max(0, elapsedMs);
  const canHandoff = backendReady && readySubscriptionAvailable;

  if (failed) {
    return {
      stage: "failed",
      virtualElapsedMs: Math.min(
        elapsed,
        SUBSCRIPTION_CREATION_TIMING.waiting,
      ),
      complete: false,
    };
  }

  if (reducedMotion) {
    if (!canHandoff) {
      return {
        stage: "waiting",
        virtualElapsedMs: SUBSCRIPTION_CREATION_TIMING.waiting,
        complete: false,
      };
    }
    const readyAt = Math.max(0, readySinceMs ?? elapsed);
    const complete =
      elapsed - readyAt >= SUBSCRIPTION_CREATION_TIMING.reducedHandoff;
    return {
      stage: complete ? "complete" : "docking",
      virtualElapsedMs: complete
        ? SUBSCRIPTION_CREATION_TIMING.waiting
        : SUBSCRIPTION_CREATION_TIMING.docking,
      complete,
    };
  }

  if (!canHandoff) {
    return {
      stage: stageAt(elapsed),
      virtualElapsedMs: Math.min(
        elapsed,
        SUBSCRIPTION_CREATION_TIMING.waiting,
      ),
      complete: false,
    };
  }

  const readyAt = Math.max(0, Math.min(readySinceMs ?? elapsed, elapsed));

  // A fast API response must not collapse the visual sequence into a single
  // skeleton frame. The card is assembled on its natural 5.6 s conveyor
  // timeline and only hands the real card off once that sequence reaches its
  // docking point. When the backend is genuinely slow, keep the short final
  // handoff so a ready profile still lands deliberately rather than popping in.
  if (readyAt < SUBSCRIPTION_CREATION_TIMING.waiting) {
    const complete = elapsed >= SUBSCRIPTION_CREATION_TIMING.waiting;
    return {
      stage: complete ? "complete" : stageAt(elapsed),
      virtualElapsedMs: Math.min(
        elapsed,
        SUBSCRIPTION_CREATION_TIMING.waiting,
      ),
      complete,
    };
  }

  const virtualStart = SUBSCRIPTION_CREATION_TIMING.docking;
  const handoffDuration = SUBSCRIPTION_CREATION_TIMING.lateReadyHandoff;
  const readinessElapsed = elapsed - readyAt;
  const virtualElapsed =
    virtualStart +
    (readinessElapsed / handoffDuration) *
      (SUBSCRIPTION_CREATION_TIMING.waiting - virtualStart);
  const complete =
    virtualElapsed >= SUBSCRIPTION_CREATION_TIMING.waiting;

  return {
    stage: complete ? "complete" : stageAt(virtualElapsed),
    virtualElapsedMs: Math.min(
      SUBSCRIPTION_CREATION_TIMING.waiting,
      virtualElapsed,
    ),
    complete,
  };
}

/**
 * Returns the next absolute elapsed-time checkpoint that can change rendered
 * state. React wakes only at these one-shot boundaries; Motion interpolates
 * between them without a per-frame state loop.
 */
export function resolveNextSubscriptionCreationWake({
  elapsedMs,
  backendReady,
  readySubscriptionAvailable,
  failed = false,
  readySinceMs,
  reducedMotion = false,
  longWaitAfterMs,
}: ResolveNextSubscriptionCreationWakeInput): number | null {
  const elapsed = Math.max(0, elapsedMs);
  if (failed) return null;

  const canHandoff = backendReady && readySubscriptionAvailable;
  const state = resolveSubscriptionCreationState({
    elapsedMs: elapsed,
    backendReady,
    readySubscriptionAvailable,
    failed,
    readySinceMs,
    reducedMotion,
  });
  if (state.complete) return null;

  if (!canHandoff) {
    const standard = [...CREATION_STAGE_BOUNDARIES, longWaitAfterMs]
      .filter((boundary) => boundary > elapsed + 0.5)
      .sort((left, right) => left - right)[0];
    return standard ?? null;
  }

  const readyAt = Math.max(0, Math.min(readySinceMs ?? elapsed, elapsed));
  if (reducedMotion) {
    const completion =
      readyAt + SUBSCRIPTION_CREATION_TIMING.reducedHandoff;
    return completion > elapsed + 0.5 ? completion : null;
  }

  if (readyAt < SUBSCRIPTION_CREATION_TIMING.waiting) {
    const nextBoundary = CREATION_STAGE_BOUNDARIES.find(
      (boundary) => boundary > elapsed + 0.5,
    );
    return nextBoundary ?? null;
  }

  const virtualStart = SUBSCRIPTION_CREATION_TIMING.docking;
  const handoffDuration = SUBSCRIPTION_CREATION_TIMING.lateReadyHandoff;
  const virtualSpan =
    SUBSCRIPTION_CREATION_TIMING.waiting - virtualStart;

  for (const boundary of CREATION_STAGE_BOUNDARIES) {
    if (boundary <= state.virtualElapsedMs + 0.5) continue;
    const realBoundary =
      readyAt +
      ((boundary - virtualStart) / virtualSpan) * handoffDuration;
    if (realBoundary > elapsed + 0.5) return realBoundary;
  }
  return null;
}

export const SUBSCRIPTION_DELETION_TIMING = {
  minimum: 1_500,
  default: 1_800,
  maximum: 2_100,
  reduced: 160,
} as const;

export function resolveSubscriptionDeletionDuration(
  reducedMotion: boolean,
  requestedMs: number = SUBSCRIPTION_DELETION_TIMING.default,
): number {
  if (reducedMotion) return SUBSCRIPTION_DELETION_TIMING.reduced;
  if (!Number.isFinite(requestedMs)) {
    return SUBSCRIPTION_DELETION_TIMING.default;
  }
  return Math.min(
    SUBSCRIPTION_DELETION_TIMING.maximum,
    Math.max(SUBSCRIPTION_DELETION_TIMING.minimum, requestedMs),
  );
}
