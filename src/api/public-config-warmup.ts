import type { LoggerPort } from '../application/ports/logger.port.js';

/**
 * THE OPERATOR CONFIG, READ BEFORE THE FIRST VISITOR ASKS FOR IT.
 *
 * Every cache of the public config lives in this process's memory, and a
 * start begins with it empty. Until something asks, nothing reads it — so the
 * first documents after an update were the ones that paid for the read, and
 * when the panel was restarting alongside and Redis answered slowly (as it
 * does while the host unpacks a new image: «Command timed out» on 01.11.2026),
 * they went out with no operator config at all. A visitor in that window saw
 * the built-in «Reiwa» (`document-public-config.ts`).
 *
 * So the API reads it at start: the server waits up to `waitMs` for the first
 * answer before it listens, and goes on trying every `retryMs` in the
 * background until one lands or `giveUpMs` has passed. One answer is enough —
 * from then on the cache always holds something to serve (`routes/branding.ts`
 * serves what it holds while it refreshes, and never drops it). Waiting longer
 * would only hold the health check: past `waitMs` the panel is not slow, it is
 * down, and the saved copy was unreadable — the background attempts cover it.
 */

export interface PublicConfigWarmupOptions {
  /** How long the start waits for the first answer. */
  readonly waitMs: number;
  /** The pause between failed attempts. */
  readonly retryMs: number;
  /** When the background attempts stop, counted from the start. */
  readonly giveUpMs: number;
  readonly logger?: Pick<LoggerPort, 'info' | 'warn'> | null;
  /** Injectable for tests. */
  readonly now?: () => number;
}

export const PUBLIC_CONFIG_WARMUP: Pick<PublicConfigWarmupOptions, 'waitMs' | 'retryMs' | 'giveUpMs'> = {
  waitMs: 3_000,
  retryMs: 2_000,
  giveUpMs: 120_000,
};

/**
 * Resolves `"held"` once `read` has answered, or `"pending"` when `waitMs`
 * came first — the attempts then go on without being waited for. Never
 * rejects, and its timers never keep the process alive.
 */
export function warmPublicConfig(
  read: () => Promise<unknown>,
  options: PublicConfigWarmupOptions,
): Promise<'held' | 'pending'> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let settled = false;
  return new Promise((resolve) => {
    const settle = (outcome: 'held' | 'pending'): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const waited = setTimeout(() => {
      if (!settled) {
        options.logger?.warn(
          { waitMs: options.waitMs },
          'public config not read yet at start; the server listens and keeps trying in the background',
        );
      }
      settle('pending');
    }, options.waitMs);
    waited.unref?.();

    const attempt = (): void => {
      // Through a resolved promise, so a `read` that throws before it returns
      // a promise is a failed attempt like any other.
      Promise.resolve().then(read).then(
        () => {
          const tookMs = now() - startedAt;
          options.logger?.info({ tookMs }, 'public config read at start');
          clearTimeout(waited);
          settle('held');
        },
        () => {
          if (now() - startedAt + options.retryMs > options.giveUpMs) {
            options.logger?.warn(
              { giveUpMs: options.giveUpMs },
              'public config still unreadable; the first visitor\'s request will read it',
            );
            return;
          }
          const next = setTimeout(attempt, options.retryMs);
          next.unref?.();
        },
      );
    };
    attempt();
  });
}
