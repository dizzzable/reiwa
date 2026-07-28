export const SUBSCRIPTION_DELETION_TIMING = {
  ignition: 250,
  sweep: 3_150,
  sweepProgress: 0.92,
  finish: 200,
  handoff: 250,
  rollback: 260,
  reducedFinish: 220,
  reducedRollback: 220,
} as const;

export type SubscriptionDeletionServerStatus =
  | "pending"
  | "success"
  | "error";

export type SubscriptionDeletionPhase =
  | "sweeping"
  | "holding"
  | "finishing"
  | "rolling-back"
  | "reduced-pending"
  | "reduced-finishing"
  | "reduced-rolling-back"
  | "complete"
  | "restored";

export interface ResolveSubscriptionDeletionStateInput {
  readonly elapsedMs: number;
  readonly serverStatus: SubscriptionDeletionServerStatus;
  readonly serverSettledAtMs: number | null;
  readonly reducedMotion: boolean;
}

export interface SubscriptionDeletionState {
  readonly phase: SubscriptionDeletionPhase;
  readonly progress: number;
  readonly rollbackFromProgress: number;
  readonly successComplete: boolean;
  readonly restoreComplete: boolean;
  readonly nextWakeAtMs: number | null;
}

function clampElapsed(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampProgress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveSubscriptionDeletionSweepProgress(
  elapsedMs: number,
): number {
  const elapsed = clampElapsed(elapsedMs);
  if (elapsed <= SUBSCRIPTION_DELETION_TIMING.ignition) return 0;
  const travellingElapsed =
    elapsed - SUBSCRIPTION_DELETION_TIMING.ignition;
  const travellingDuration =
    SUBSCRIPTION_DELETION_TIMING.sweep -
    SUBSCRIPTION_DELETION_TIMING.ignition;
  return clampProgress(
    (travellingElapsed / travellingDuration) *
      SUBSCRIPTION_DELETION_TIMING.sweepProgress,
  );
}

/**
 * Pure presentation policy for the delete effect.
 *
 * The server and cache lifecycle are intentionally not delayed by this
 * timeline. A successful response may remove the canonical row immediately;
 * the carousel keeps a frozen local snapshot mounted until `successComplete`.
 */
export function resolveSubscriptionDeletionState({
  elapsedMs,
  serverStatus,
  serverSettledAtMs,
  reducedMotion,
}: ResolveSubscriptionDeletionStateInput): SubscriptionDeletionState {
  const elapsed = clampElapsed(elapsedMs);
  const settledAt =
    serverStatus === "pending"
      ? null
      : clampElapsed(serverSettledAtMs ?? 0);

  if (reducedMotion) {
    if (serverStatus === "pending" || settledAt === null) {
      return {
        phase: "reduced-pending",
        progress: 0,
        rollbackFromProgress: 0,
        successComplete: false,
        restoreComplete: false,
        nextWakeAtMs: null,
      };
    }

    const duration =
      serverStatus === "success"
        ? SUBSCRIPTION_DELETION_TIMING.reducedFinish
        : SUBSCRIPTION_DELETION_TIMING.reducedRollback;
    const endAt = settledAt + duration;
    if (elapsed >= endAt) {
      return {
        phase: serverStatus === "success" ? "complete" : "restored",
        progress: serverStatus === "success" ? 1 : 0,
        rollbackFromProgress: 0,
        successComplete: serverStatus === "success",
        restoreComplete: serverStatus === "error",
        nextWakeAtMs: null,
      };
    }

    return {
      phase:
        serverStatus === "success"
          ? "reduced-finishing"
          : "reduced-rolling-back",
      progress:
        serverStatus === "success"
          ? clampProgress((elapsed - settledAt) / duration)
          : 0,
      rollbackFromProgress: 0,
      successComplete: false,
      restoreComplete: false,
      nextWakeAtMs: endAt,
    };
  }

  if (serverStatus === "error" && settledAt !== null) {
    const rollbackFromProgress =
      settledAt >= SUBSCRIPTION_DELETION_TIMING.sweep
        ? SUBSCRIPTION_DELETION_TIMING.sweepProgress
        : resolveSubscriptionDeletionSweepProgress(settledAt);
    const rollbackEnd =
      settledAt + SUBSCRIPTION_DELETION_TIMING.rollback;
    if (elapsed >= rollbackEnd) {
      return {
        phase: "restored",
        progress: 0,
        rollbackFromProgress,
        successComplete: false,
        restoreComplete: true,
        nextWakeAtMs: null,
      };
    }
    return {
      phase: "rolling-back",
      progress:
        rollbackFromProgress *
        (1 -
          clampProgress(
            (elapsed - settledAt) /
              SUBSCRIPTION_DELETION_TIMING.rollback,
          )),
      rollbackFromProgress,
      successComplete: false,
      restoreComplete: false,
      nextWakeAtMs: rollbackEnd,
    };
  }

  if (elapsed < SUBSCRIPTION_DELETION_TIMING.sweep) {
    return {
      phase: "sweeping",
      progress: resolveSubscriptionDeletionSweepProgress(elapsed),
      rollbackFromProgress: 0,
      successComplete: false,
      restoreComplete: false,
      nextWakeAtMs: SUBSCRIPTION_DELETION_TIMING.sweep,
    };
  }

  if (serverStatus === "pending" || settledAt === null) {
    return {
      phase: "holding",
      progress: SUBSCRIPTION_DELETION_TIMING.sweepProgress,
      rollbackFromProgress: 0,
      successComplete: false,
      restoreComplete: false,
      nextWakeAtMs: null,
    };
  }

  const finishStartedAt = Math.max(
    SUBSCRIPTION_DELETION_TIMING.sweep,
    settledAt,
  );
  const finishEndsAt =
    finishStartedAt + SUBSCRIPTION_DELETION_TIMING.finish;
  if (elapsed >= finishEndsAt) {
    return {
      phase: "complete",
      progress: 1,
      rollbackFromProgress: 0,
      successComplete: true,
      restoreComplete: false,
      nextWakeAtMs: null,
    };
  }

  return {
    phase: "finishing",
    progress:
      SUBSCRIPTION_DELETION_TIMING.sweepProgress +
      (1 - SUBSCRIPTION_DELETION_TIMING.sweepProgress) *
        clampProgress(
          (elapsed - finishStartedAt) /
            SUBSCRIPTION_DELETION_TIMING.finish,
        ),
    rollbackFromProgress: 0,
    successComplete: false,
    restoreComplete: false,
    nextWakeAtMs: finishEndsAt,
  };
}
