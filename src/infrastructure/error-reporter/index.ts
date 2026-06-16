/**
 * Error reporter
 * ──────────────
 * Best-effort bridge that forwards reiwa runtime errors to rezeis as system
 * events (`POST /api/internal/system/error`), so panel AND reiwa failures land
 * in one place: the rezeis audit log → Events page → .txt export.
 *
 * Hardening (a bot/api in a crash loop must never DDoS rezeis):
 *   - de-dup: the same message is reported at most once per `DEDUP_MS`.
 *   - rate cap: at most `MAX_PER_MIN` reports per rolling minute.
 *   - fire-and-forget: never awaited, never throws.
 */
import type { AdminClient } from '../../lib/admin-client.js';

export type ErrorSource = 'api' | 'bot' | 'worker' | 'web';

export interface ErrorReporter {
  report(input: {
    readonly message: string;
    readonly level?: 'error' | 'warning';
    readonly context?: Record<string, unknown>;
    readonly stack?: string;
  }): void;
}

const DEDUP_MS = 60_000;
const MAX_PER_MIN = 30;

export function createErrorReporter(opts: {
  readonly adminClient: AdminClient | null;
  readonly source: ErrorSource;
}): ErrorReporter {
  const { adminClient, source } = opts;
  const recent = new Map<string, number>();
  let windowStart = Date.now();
  let windowCount = 0;

  return {
    report(input): void {
      if (adminClient === null) return;
      const now = Date.now();

      // De-dup identical messages within the window.
      const key = `${input.level ?? 'error'}:${input.message}`.slice(0, 200);
      const last = recent.get(key);
      if (last !== undefined && now - last < DEDUP_MS) return;
      recent.set(key, now);
      if (recent.size > 200) recent.clear();

      // Rolling per-minute cap.
      if (now - windowStart > 60_000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount >= MAX_PER_MIN) return;
      windowCount += 1;

      void adminClient.system
        .reportError({
          source,
          message: input.message.slice(0, 2000),
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.stack !== undefined ? { stack: input.stack.slice(0, 8000) } : {}),
        })
        .catch(() => {
          /* best-effort — swallow; never let reporting failures cascade */
        });
    },
  };
}
