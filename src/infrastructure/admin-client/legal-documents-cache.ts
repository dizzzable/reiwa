/**
 * Per-locale cache for the operator's legal documents, used by the bot.
 *
 * The cabinet deliberately does NOT cache these — an operator's edit has to be
 * the wording the next visitor agrees to, so the HTTP route says `no-store` and
 * the SPA query has `staleTime: 0`. The bot's need is different: its rules
 * screen only asks "is there anything to link to at all", never renders the
 * text, and a stale answer to that question costs a wrong button for at most a
 * minute.
 *
 * Why the bot needs a cache when the cabinet does not: `AdminTransport` runs a
 * single 50-connection pool shared by everything the bot does — payments,
 * subscriptions, support. An uncached call has no timeout of its own, only the
 * transport's 10s headers timeout, so while the panel is slow or down every tap
 * on «Rules» parks a connection for ten seconds in the pool that serves
 * checkout. Fifty concurrent taps would drain it. `PolicyCache` — read two
 * lines earlier in the same handler — already avoids exactly this with a TTL,
 * single-flight and last-known-good; this mirrors it rather than inventing a
 * second shape.
 *
 * And it never holds an update up (W8 report D1): the bot handles updates one
 * at a time, so a tap that waits on the panel holds every chat behind it. A
 * locale the cache holds is answered at once, whatever its age — past the TTL
 * or after an operator's edit, a refresh runs behind it (stale-while-
 * revalidate). Only a locale never read yet waits, and only `waitBudgetMs`;
 * the taps after it do not wait on the same panel read, but still ask Redis for
 * the saved copy — a budget at most, once per read of Redis (`savedOrNone`).
 * The press itself may wait a moment longer for a change reiwa has already
 * heard of — `catchUp`, which the bot's freshness middleware calls before the
 * rules screen, within the press's budget.
 *
 * With a last-known-good store (the bot's, `configureLegalDocumentsCache`), the
 * last documents the panel answered per language are kept in reiwa's Redis
 * too, so a bot restarted while the panel is down still links «Правила» to the
 * cabinet's `/legal` page instead of the legacy rules link (CD1 report §5.5).
 *
 * Failure with nothing held and nothing saved returns an EMPTY list, which the
 * caller reads as "no documents" and falls back to the legacy rules link. That
 * is the safe direction here: the consequence is an older link, not a missing
 * screen.
 */
import type { LoggerPort } from '../../application/ports/logger.port.js';
import { configVersionOf } from '../config-versions/config-version.js';
import {
  LAST_KNOWN_GOOD_UNREADABLE,
  NOOP_LAST_KNOWN_GOOD,
  legalDocumentsLastKnownGood,
  type LastKnownGoodStorePort,
  type LastKnownGoodUnreadable,
} from '../config-versions/last-known-good.js';
import type { KnownPanelChange } from '../config-versions/latest.js';
import { firstAnswer, settlesWithin } from '../config-versions/within-budget.js';
import type { AdminClient } from './admin-client.js';
import type { LegalDocument } from './namespaces/legal-documents.js';

const CACHE_TTL_MS = 60_000;

/**
 * How long a tap on a locale never read yet waits for the panel before it
 * answers "no documents". The budget of a message's words in the bot
 * (`bot/lib/config-within.ts`).
 */
export const LEGAL_DOCUMENTS_WAIT_BUDGET_MS = 1_000;

/**
 * How long a version the key of latest versions keeps naming is not read for
 * again, once a read made on its account has landed with another one
 * (`catchUp`; `BotConfigCache` has the same rule).
 */
const POLLED_RECHECK_MS = 5 * 60 * 1000;

interface Entry {
  readonly documents: readonly LegalDocument[];
  readonly fetchedAt: number;
  /** The answer's version (`config-version.ts`), for the version poll. */
  readonly version: string;
  /** Kept across `invalidate()`: served while the edit is read. */
  readonly superseded: boolean;
  /**
   * When the read these documents came from began; `-Infinity` for the saved
   * copy. A change reiwa heard of after it is one they may not have (`catchUp`).
   */
  readonly readStartedAt: number;
}

/** A read of one locale, whoever began it, as `catchUp` waits on it. */
interface ReadAttempt {
  readonly startedAt: number;
  readonly done: Promise<unknown>;
  settled: boolean;
  /** A press already waited its whole budget on it: the next ones do not. */
  waitedOut: boolean;
}

export interface LegalDocumentsCacheOptions {
  /**
   * Where the last documents the panel answered, per language, survive a
   * restart. The bot's store (`bot/main.ts`); absent, they live in memory only.
   */
  readonly lastKnownGood?: LastKnownGoodStorePort;
  readonly logger?: LoggerPort;
}

/** The saved copy of one language, as the store gave it. */
interface SavedDocuments {
  readonly documents: readonly LegalDocument[];
  readonly version: string;
}

/** A read of one language's saved copy (`savedRead`), as the taps waiting on it see it. */
interface SavedRead {
  /** What the store answered. Never rejects. */
  readonly copy: Promise<SavedDocuments | null | LastKnownGoodUnreadable>;
  /**
   * A tap came away from it with no copy — its budget ran out first, or the
   * store had none: the taps after it do not wait on it again. One wait per read
   * of Redis, not one per update queued behind a Redis that hangs. A copy it
   * brings later is held all the same (`savedCopy`).
   */
  waitedOut: boolean;
}

export class LegalDocumentsCache {
  private readonly values = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<readonly LegalDocument[]>>();
  /**
   * Bumped by `invalidate()`, for every locale at once. Same rule as
   * `PolicyCache`: a fetch begun before the bump may have read the documents
   * from before the operator's edit, so nobody may join it and it may not store
   * its answer.
   */
  private generation = 0;
  /** Per locale: the generation whose cold read already waited out its budget. */
  private readonly budgetSpent = new Map<string, number>();
  /** Per locale: the newest read begun, whoever began it (`catchUp`). */
  private readonly lastAttempt = new Map<string, ReadAttempt>();
  /** When `invalidate()` last said the panel has newer documents — what `catchUp` knows by itself. */
  private supersededAt = Number.NEGATIVE_INFINITY;
  /** Per locale: the polled version a read was last begun for, and when (`catchUp`). */
  private readonly polledCheck = new Map<string, { readonly version: string; readonly startedAt: number }>();
  /** Per locale: the change `catchUp` last began a read for. */
  private readonly caughtUpFor = new Map<string, number>();
  /**
   * Per locale: the saved copy's read — once per process once Redis has
   * answered it, nothing else writes it while the bot runs. A read Redis failed
   * is forgotten, and the next tap asks again (`savedRead`).
   */
  private readonly saved = new Map<string, SavedRead>();
  /**
   * Per locale: the version the store holds, as far as this process knows — a
   * copy is written only when it moves. Set only by a save Redis took (or by the
   * copy read back): a failed save must not make the next answer skip it.
   */
  private readonly storedVersion = new Map<string, string>();
  /** Per locale: the version a save is out for — one write per version, however many answers carry it. */
  private readonly savingVersion = new Map<string, string>();
  private readonly lastKnownGood: LastKnownGoodStorePort;
  private readonly logger: LoggerPort | undefined;

  public constructor(
    private readonly fetchFn: (locale: string) => Promise<readonly LegalDocument[]>,
    private readonly ttlMs: number = CACHE_TTL_MS,
    private readonly waitBudgetMs: number = LEGAL_DOCUMENTS_WAIT_BUDGET_MS,
    options: LegalDocumentsCacheOptions = {},
  ) {
    this.lastKnownGood = options.lastKnownGood ?? NOOP_LAST_KNOWN_GOOD;
    this.logger = options.logger;
  }

  public async get(locale: string): Promise<readonly LegalDocument[]> {
    const cached = this.values.get(locale);
    if (cached !== undefined) {
      const due = cached.superseded || Date.now() - cached.fetchedAt >= this.ttlMs;
      if (due && !this.inFlight.has(locale)) void this.startRefresh(locale);
      return cached.documents;
    }
    const startedAt = this.generation;
    const pending = this.inFlight.get(locale) ?? this.startRefresh(locale);
    if (this.budgetSpent.get(locale) === startedAt) return this.savedOrNone(locale);
    // The saved copy as soon as Redis gives it; the panel within the budget
    // when there is none.
    const read = this.savedRead(locale);
    const first = await firstAnswer({ fetched: pending, saved: this.savedCopy(locale, read), budgetMs: this.waitBudgetMs });
    if (first !== null) return first;
    if (startedAt === this.generation) this.budgetSpent.set(locale, startedAt);
    read.waitedOut = true;
    return this.values.get(locale)?.documents ?? [];
  }

  /**
   * A tap on a locale never read, after one tap waited its budget on the panel
   * read still out. It used to answer "no documents" at once — the legacy rules
   * link — the copy asked for only when the panel read failed: ten seconds with
   * a panel that hangs, with Redis back after two (review R3b-02). The copy is
   * asked for again (the store paces the asks, one GET per pause), a budget at
   * most, and a read of Redis a tap already came away from empty is not waited
   * on again (`SavedRead.waitedOut`).
   */
  private async savedOrNone(locale: string): Promise<readonly LegalDocument[]> {
    const read = this.savedRead(locale);
    const copy = read.waitedOut
      ? null
      : await firstAnswer({ fetched: this.savedCopy(locale, read), budgetMs: this.waitBudgetMs });
    if (copy === null) read.waitedOut = true;
    // Documents the panel answered meanwhile are newer than the copy.
    return this.values.get(locale)?.documents ?? copy ?? [];
  }

  /**
   * An operator edited a document: every locale is read again. What is held
   * stays, marked superseded — the next tap is answered with it at once while
   * its refresh runs. Called on the operator-edit webhook.
   */
  public invalidate(): void {
    for (const [locale, entry] of this.values) {
      this.values.set(locale, { ...entry, superseded: true });
    }
    // The fetches in flight too: a tap joining one would get the old documents.
    this.inFlight.clear();
    this.generation += 1;
    this.supersededAt = Date.now();
  }

  /** Re-read every locale held now, in the background — the version poll's reload. */
  public refreshHeld(): void {
    for (const locale of this.values.keys()) {
      if (!this.inFlight.has(locale)) void this.startRefresh(locale);
    }
  }

  /** The version of the documents held for `locale`; `null` when none are. */
  public heldVersion(locale: string): string | null {
    return this.values.get(locale)?.version ?? null;
  }

  /**
   * Bring the documents held for `locale` up to a change reiwa already knows
   * of, waiting at most `budgetMs` — asked before the rules screen is rendered
   * (`bot/middleware/config-freshness.ts`). The rules of `BotConfigCache.catchUp`:
   * behind when a hint, a differing polled version or an `invalidate()` is newer
   * than the read the documents came from began; then the read begun since is
   * waited for, or one is begun — not joining a read from before the change,
   * whose answer is then not kept; one read per change, one wait per read.
   * Never rejects. Nothing held for the locale: nothing to do — the screen's own
   * `get()` reads.
   */
  public async catchUp(locale: string, known: KnownPanelChange, budgetMs: number): Promise<void> {
    const entry = this.values.get(locale);
    if (entry === undefined) return;
    const since = this.behindSince(locale, entry, known);
    if (since === null) return;
    let attempt = this.lastAttempt.get(locale);
    // One read per change even when the change is stamped ahead of this clock.
    if ((attempt === undefined || attempt.startedAt < since) && since !== this.caughtUpFor.get(locale)) {
      this.caughtUpFor.set(locale, since);
      // A read begun before the change may carry the documents from before it.
      this.inFlight.delete(locale);
      this.generation += 1;
      if (known.polled !== undefined && known.polled.version !== entry.version) {
        this.polledCheck.set(locale, { version: known.polled.version, startedAt: Date.now() });
      }
      void this.startRefresh(locale);
      attempt = this.lastAttempt.get(locale);
    }
    if (attempt === undefined || attempt.settled || attempt.waitedOut || budgetMs <= 0) return;
    if (!(await settlesWithin(attempt.done, budgetMs))) attempt.waitedOut = true;
  }

  /** The newest known change the held documents may not have, or `null`. */
  private behindSince(locale: string, entry: Entry, known: KnownPanelChange): number | null {
    let since: number | null = null;
    const newer = (at: number | undefined): void => {
      if (at === undefined || !(at > entry.readStartedAt)) return;
      if (since === null || at > since) since = at;
    };
    newer(this.supersededAt);
    newer(known.hintedAt);
    const polled = known.polled;
    if (polled !== undefined && polled.version !== entry.version && !this.polledChecked(locale, polled.version, entry)) {
      newer(polled.at);
    }
    return since;
  }

  private polledChecked(locale: string, version: string, entry: Entry): boolean {
    const check = this.polledCheck.get(locale);
    return (
      check !== undefined &&
      check.version === version &&
      entry.readStartedAt >= check.startedAt &&
      Date.now() - check.startedAt < POLLED_RECHECK_MS
    );
  }

  /** Starts one fetch for `locale` and holds its slot until it settles. Never rejects. */
  private startRefresh(locale: string): Promise<readonly LegalDocument[]> {
    const readStartedAt = Date.now();
    const refresh = this.refresh(locale, this.generation, readStartedAt);
    this.inFlight.set(locale, refresh);
    const attempt: ReadAttempt = { startedAt: readStartedAt, done: refresh, settled: false, waitedOut: false };
    this.lastAttempt.set(locale, attempt);
    void refresh.finally(() => {
      attempt.settled = true;
      // After an invalidate the slot may already hold a newer fetch.
      if (this.inFlight.get(locale) === refresh) this.inFlight.delete(locale);
    });
    return refresh;
  }

  private async refresh(locale: string, startedAt: number, readStartedAt: number): Promise<readonly LegalDocument[]> {
    try {
      const fresh = await this.fetchFn(locale);
      if (startedAt === this.generation) {
        const version = configVersionOf(fresh);
        this.values.set(locale, {
          documents: fresh,
          fetchedAt: Date.now(),
          version,
          superseded: false,
          readStartedAt,
        });
        this.keep(locale, fresh, version);
      }
      return fresh;
    } catch {
      const stale = this.values.get(locale);
      if (stale !== undefined) {
        // Last-known-good, with the clock reset so an outage is not hammered
        // once per tap — and no longer superseded: an edit the panel cannot
        // deliver is not asked for again on every tap either.
        if (startedAt === this.generation) {
          this.values.set(locale, { ...stale, fetchedAt: Date.now(), superseded: false });
        }
        return stale.documents;
      }
      // Nothing held — a restart during an outage: the documents saved before it.
      return (await this.savedCopy(locale, this.savedRead(locale))) ?? [];
    }
  }

  /**
   * The read of the documents saved for `locale`: the one out or answered, else
   * a new one. From the store once per process once Redis answered; a read
   * Redis failed is NOT remembered as "no copy" (review R2a-01): the next tap
   * asks again, paced by the store.
   */
  private savedRead(locale: string): SavedRead {
    const held = this.saved.get(locale);
    if (held !== undefined) return held;
    const copy: Promise<SavedDocuments | null | LastKnownGoodUnreadable> = this.lastKnownGood
      .load(legalDocumentsLastKnownGood(locale))
      .then(
        (record) =>
          record === null || record === LAST_KNOWN_GOOD_UNREADABLE
            ? record
            : { documents: record.payload as unknown as readonly LegalDocument[], version: record.hash },
        // A store that throws despite its contract could not read either.
        (): LastKnownGoodUnreadable => LAST_KNOWN_GOOD_UNREADABLE,
      );
    const read: SavedRead = { copy, waitedOut: false };
    this.saved.set(locale, read);
    void copy.then((record) => {
      if (record === LAST_KNOWN_GOOD_UNREADABLE && this.saved.get(locale) === read) this.saved.delete(locale);
    });
    return read;
  }

  /**
   * The documents saved for `locale`, from `read`, or `null` — also while Redis
   * cannot be read. Held — like documents gone stale, refreshed on the next tap
   * — only while nothing else is, and not by a read an invalidation overtook.
   */
  private savedCopy(locale: string, read: SavedRead): Promise<readonly LegalDocument[] | null> {
    const startedAt = this.generation;
    return read.copy.then((record) => {
      if (record === null || record === LAST_KNOWN_GOOD_UNREADABLE) return null;
      // What the store holds, unless this process has written since.
      if (!this.storedVersion.has(locale)) this.storedVersion.set(locale, record.version);
      if (startedAt === this.generation && !this.values.has(locale)) {
        this.values.set(locale, {
          documents: record.documents,
          fetchedAt: Number.NEGATIVE_INFINITY,
          version: record.version,
          superseded: false,
          readStartedAt: Number.NEGATIVE_INFINITY,
        });
        this.logger?.info({ locale }, 'LegalDocumentsCache: serving the documents saved before this start');
      }
      return record.documents;
    });
  }

  /**
   * Save what the panel answered, when it is not what the store already holds.
   * Fire-and-forget; the version counts as stored only once Redis took it — a
   * save that failed used to be remembered as done, and the documents were not
   * written again until they changed.
   */
  private keep(locale: string, documents: readonly LegalDocument[], version: string): void {
    if (this.storedVersion.get(locale) === version || this.savingVersion.get(locale) === version) return;
    this.savingVersion.set(locale, version);
    const settle = (outcome: unknown): void => {
      if (this.savingVersion.get(locale) === version) this.savingVersion.delete(locale);
      if (outcome === 'saved') this.storedVersion.set(locale, version);
    };
    void this.lastKnownGood
      .save(legalDocumentsLastKnownGood(locale), documents as unknown as unknown[], version)
      .then(settle, () => settle('not-saved'));
  }
}

let cache: LegalDocumentsCache | null = null;
let configured: LegalDocumentsCacheOptions = {};

/**
 * Where the process-wide cache keeps its saved copies, and what it logs
 * through. `bot/main.ts` calls it before the first read; a cache built before
 * the call keeps what it was built with. The API process never builds this
 * cache (its legal-documents route reads the panel live) and does not call it.
 */
export function configureLegalDocumentsCache(options: LegalDocumentsCacheOptions): void {
  configured = options;
}

/** Process-wide cache bound to the given client on first use. */
export function getLegalDocumentsCache(adminClient: AdminClient): LegalDocumentsCache {
  cache ??= new LegalDocumentsCache(
    (locale) => adminClient.legalDocuments.list(locale),
    CACHE_TTL_MS,
    LEGAL_DOCUMENTS_WAIT_BUDGET_MS,
    configured,
  );
  return cache;
}

/** The cache when one exists, without building it — for the version poll. */
export function peekLegalDocumentsCache(): LegalDocumentsCache | null {
  return cache;
}

/**
 * Drops the cached documents; does nothing when no cache has been built.
 *
 * Only the bot process builds one (`bot/pages/rules.ts`), so the call that
 * reaches it is the bot listener's `/invalidate-policy`, where reiwa-api relays
 * the operator-edit webhook. The same call in the API process finds nothing.
 */
export function invalidateLegalDocumentsCache(): void {
  cache?.invalidate();
}

/**
 * Test hook — replaces the singleton, mirroring `setPolicyCache`.
 *
 * A process-wide cache is right in production and poison in a test file: the
 * first case binds it to its own fake client, and every later case then reads
 * that one's answers through a 60-second TTL. Passing `null` unbinds it so the
 * next `get` builds a fresh one.
 */
export function setLegalDocumentsCache(next: LegalDocumentsCache | null): void {
  cache = next;
}
