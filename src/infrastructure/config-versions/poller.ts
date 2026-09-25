/**
 * The version poll: the safety net under the panel's "drop your cache" webhook.
 *
 * The webhook is the fast path — a save reaches reiwa in about a second — but it
 * can be lost: reiwa unreachable for longer than the relay's two attempts, the
 * panel crashing between its commit and the enqueue, a panel boot with new env
 * defaults, a backup restore (no webhook at all, W8 report D10). Before this, a
 * lost hint healed only by TTL: a minute for the cabinet, four for the bot.
 *
 * Every `intervalMs` each process (reiwa-api and reiwa-bot alike) asks the panel
 * for the version of every settings group (`POST /api/internal/config-versions`),
 * compares each with the version of the copy it holds, and re-reads only the
 * groups that differ — through the same reset the webhook uses, so the same
 * generation guards apply — then reloads them at once, so what it holds and
 * what it reports move to the new version without waiting for a customer to ask.
 *
 * The request carries what the process holds, too. The panel keeps the latest
 * report per process and, two minutes after an operator's save, raises a card
 * only if the process still holds the old version (the owner's rule: warn only
 * when a change has not arrived within two minutes). A poll's report is taken
 * BEFORE the re-reads it starts, so a poll that re-read something is followed
 * at once — as soon as the re-reads have landed — by another, whose report is
 * the one the panel keeps. Without it, a first poll after a blip, 105 s after a
 * save, left the panel a report of the old version for the check at 120 s, and
 * the operator a false «не принял» card about a change that had arrived (review
 * R2a-04). The follow-up re-reads nothing it has just re-read (the retry window
 * below), so it cannot loop.
 *
 * A poll that fails must never hold anything up or fill the log: it runs off
 * the request path on an unref'd timer, one at a time, and backs off — twice
 * the wait per failure in a row, up to `maxBackoffMs`. The first failure of a
 * streak is a warning, the rest are debug, and the recovery is one info line.
 * A panel that predates the route answers 404: said once, and asked again only
 * every `maxBackoffMs`, in case it is upgraded.
 */
import type { LoggerPort } from '../../application/ports/logger.port.js';
import { UpstreamError } from '../../core/errors/index.js';
import type { ConfigVersionKey } from './config-version.js';

/** One settings group this process holds a copy of. */
export interface VersionedGroup {
  readonly key: ConfigVersionKey;
  /** The version of the copy held now; `null` when nothing is held (the next read asks the panel). */
  readonly held: () => string | null;
  /** Drop the copy — the webhook's reset for this group. Must not throw. */
  readonly reset: () => void;
  /**
   * Read the group again now, after `reset`, so the new copy is held before
   * anyone asks. A no-op where the group's cache has no reader to call.
   */
  readonly reload: () => unknown;
}

/** Who is asking; the panel keeps one report per process. */
export type ConfigVersionConsumer = 'api' | 'bot';

/** What the poll sends: which versions this process holds. */
export interface ConfigVersionsReport {
  readonly consumer: ConfigVersionConsumer;
  readonly held: Readonly<Record<string, string | null>>;
}

export interface ConfigVersionPollerOptions {
  readonly consumer: ConfigVersionConsumer;
  readonly groups: readonly VersionedGroup[];
  /** The panel call: `AdminClient.system.pollConfigVersions`. */
  readonly poll: (report: ConfigVersionsReport) => Promise<unknown>;
  readonly logger?: LoggerPort;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  /** A poll that has not answered within this is a failed one. */
  readonly timeoutMs?: number;
  /**
   * A group already re-read for a panel version is not re-read for the same
   * version again until this has passed. A copy reiwa keeps rejecting (a theme
   * value its guard refuses) otherwise costs a panel read every poll.
   */
  readonly retryRefreshAfterMs?: number;
  /** Up to this much is added to each wait, so two processes do not poll in step. */
  readonly jitterMs?: number;
  /**
   * Hears every answered poll: the panel's version of each group, and when the
   * answer came. `api/main.ts` and `bot/main.ts` keep them in reiwa's Redis
   * (`latest.ts`), which the bot compares its copy with on every press. Called
   * before this poll re-reads anything; a throw is logged and forgotten.
   */
  readonly onVersions?: (versions: Readonly<Record<string, string>>, answeredAt: number) => void;
}

export const CONFIG_VERSION_POLL_INTERVAL_MS = 20_000;
export const CONFIG_VERSION_POLL_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_REFRESH_AFTER_MS = 5 * 60_000;
const DEFAULT_JITTER_MS = 2_000;
/** The first poll waits for the process to settle; its caches warm on their own reads. */
const FIRST_POLL_DELAY_MS = 5_000;
/** The wait before the poll that follows a re-read: none — its re-reads have landed (see the header). */
export const CONFIG_VERSION_FOLLOW_UP_DELAY_MS = 0;

/** The versions out of the panel's answer, or `null` when it has none. */
function versionsOf(answer: unknown): Readonly<Record<string, string>> | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const versions = (answer as { versions?: unknown }).versions;
  if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(versions as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ConfigVersionPoller {
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly retryRefreshAfterMs: number;
  private readonly jitterMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Failed polls in a row. */
  private failures = 0;
  /** The panel answered 404: it predates the route. */
  private unsupported = false;
  /** Per group: the panel version last re-read for, and when. */
  private readonly attempted = new Map<string, { readonly version: string; readonly at: number }>();

  public constructor(private readonly options: ConfigVersionPollerOptions) {
    this.intervalMs = options.intervalMs ?? CONFIG_VERSION_POLL_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? CONFIG_VERSION_POLL_MAX_BACKOFF_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryRefreshAfterMs = options.retryRefreshAfterMs ?? DEFAULT_RETRY_REFRESH_AFTER_MS;
    this.jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  }

  public start(firstDelayMs: number = FIRST_POLL_DELAY_MS): void {
    if (this.running) return;
    this.running = true;
    this.schedule(firstDelayMs);
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * One poll. Answers the wait before the next one. Never rejects: every
   * failure is counted, logged by the rules in the header, and turned into a
   * longer wait.
   */
  public async tick(): Promise<number> {
    const held: Record<string, string | null> = {};
    for (const group of this.options.groups) held[group.key] = this.heldOf(group);

    let answer: unknown;
    try {
      answer = await this.withTimeout(this.options.poll({ consumer: this.options.consumer, held }));
    } catch (err: unknown) {
      return this.failed(err);
    }
    const versions = versionsOf(answer);
    if (versions === null) return this.failed(new Error('the panel answered without versions'));
    this.recovered();

    const now = Date.now();
    try {
      this.options.onVersions?.(versions, now);
    } catch (err: unknown) {
      this.options.logger?.debug({ err: describe(err) }, 'config versions: recording the answer failed');
    }
    const rereads: Promise<void>[] = [];
    for (const group of this.options.groups) {
      const current = versions[group.key];
      const mine = held[group.key];
      // Nothing held: the next read asks the panel anyway. A key the panel does
      // not version (an older panel): nothing to compare with.
      if (current === undefined || mine === null || mine === undefined || mine === current) continue;
      const last = this.attempted.get(group.key);
      if (last !== undefined && last.version === current && now - last.at < this.retryRefreshAfterMs) continue;
      this.attempted.set(group.key, { version: current, at: now });
      this.options.logger?.info(
        { group: group.key, consumer: this.options.consumer },
        'config versions: the panel has a newer copy than this process holds; re-reading it',
      );
      rereads.push(this.refresh(group));
    }
    if (rereads.length === 0) return this.intervalMs;
    // This poll's report was taken before these re-reads: the next one goes
    // out as soon as they have landed — at most a poll's timeout from now — so
    // the report the panel keeps is what this process holds after them.
    await this.settledWithin(Promise.all(rereads), this.timeoutMs);
    return CONFIG_VERSION_FOLLOW_UP_DELAY_MS;
  }

  /** Whether `work` settled within `ms`; cancels nothing. */
  private async settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private heldOf(group: VersionedGroup): string | null {
    try {
      return group.held();
    } catch {
      return null;
    }
  }

  /** Reset and re-read one group. Resolves when the re-read has landed, either way; never rejects. */
  private refresh(group: VersionedGroup): Promise<void> {
    try {
      group.reset();
      return Promise.resolve(group.reload()).then(
        () => undefined,
        (err: unknown) => {
          this.options.logger?.warn({ err: describe(err), group: group.key }, 'config versions: re-read failed');
        },
      );
    } catch (err: unknown) {
      this.options.logger?.warn({ err: describe(err), group: group.key }, 'config versions: re-read failed');
      return Promise.resolve();
    }
  }

  private failed(err: unknown): number {
    this.failures += 1;
    if (err instanceof UpstreamError && err.status === 404) {
      if (!this.unsupported) {
        this.unsupported = true;
        this.options.logger?.info(
          { consumer: this.options.consumer },
          'config versions: the panel does not serve them (an older panel); the webhook and the TTLs keep settings fresh',
        );
      }
      return this.maxBackoffMs;
    }
    if (this.failures === 1) {
      this.options.logger?.warn(
        { err: describe(err), consumer: this.options.consumer },
        'config versions: poll failed; backing off until the panel answers',
      );
    } else {
      this.options.logger?.debug({ err: describe(err), failures: this.failures }, 'config versions: poll failed again');
    }
    return Math.min(this.intervalMs * 2 ** this.failures, this.maxBackoffMs);
  }

  private recovered(): void {
    if (this.failures > 0 && !this.unsupported) {
      this.options.logger?.info({ consumer: this.options.consumer }, 'config versions: the panel answers again');
    }
    this.failures = 0;
    this.unsupported = false;
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${this.timeoutMs} ms`)), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    this.timer = setTimeout(() => {
      void this.run();
    }, delayMs + jitter);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    this.timer = null;
    const next = await this.tick();
    this.schedule(next);
  }
}
