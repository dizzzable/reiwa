/**
 * Process-level error guards
 * ──────────────────────────
 * Last line of defence for each reiwa runtime (api / bot / worker): catches
 * stray `unhandledRejection`s and `uncaughtException`s that escape the
 * per-handler try/catch, the Express error middleware and grammy's
 * `bot.catch`. Without these, such failures vanish from the panel and an
 * uncaught throw silently kills the process with Node's default behaviour.
 *
 * Policy (deliberately asymmetric):
 *   - unhandledRejection → log + report, KEEP RUNNING. A single missed
 *     `await` shouldn't take down a user-facing service; surfacing it is
 *     enough to get it fixed.
 *   - uncaughtException   → log fatal + report, then EXIT(1) after a short
 *     grace window. Process state may be corrupt, so we let the supervisor
 *     (Docker `restart`) bring up a clean instance; the delay lets the
 *     best-effort report flush first.
 */
import type { ErrorReporter } from './index.js';

interface GuardLogger {
  error(ctx: object, message: string): void;
  fatal(ctx: object, message: string): void;
}

let installed = false;

export function installProcessErrorGuards(opts: {
  readonly logger: GuardLogger;
  readonly errorReporter: ErrorReporter;
  /** Exit the process after an uncaughtException. Default `true`. */
  readonly exitOnUncaught?: boolean;
  /** Grace window (ms) before exit so the report can flush. Default 1000. */
  readonly exitGraceMs?: number;
}): void {
  // Idempotent: a process only ever needs one set of guards.
  if (installed) return;
  installed = true;

  const { logger, errorReporter } = opts;
  const exitOnUncaught = opts.exitOnUncaught ?? true;
  const exitGraceMs = opts.exitGraceMs ?? 1000;

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err }, 'Unhandled promise rejection');
    errorReporter.report({
      message: `Unhandled promise rejection: ${err.message}`,
      stack: err.stack,
      context: { scope: 'process.unhandledRejection' },
    });
  });

  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ err }, 'Uncaught exception');
    errorReporter.report({
      message: `Uncaught exception: ${err.message}`,
      stack: err.stack,
      context: { scope: 'process.uncaughtException' },
    });
    if (exitOnUncaught) {
      setTimeout(() => process.exit(1), exitGraceMs).unref();
    }
  });
}

/** Test-only: reset the install guard so a fresh process can be simulated. */
export function __resetProcessErrorGuardsForTest(): void {
  installed = false;
}
