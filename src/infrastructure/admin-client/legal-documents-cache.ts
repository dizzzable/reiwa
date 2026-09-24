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
 * revalidate). Only a locale never read yet waits, and only `waitBudgetMs`.
 *
 * Failure returns an EMPTY list, which the caller reads as "no documents" and
 * falls back to the legacy rules link. That is the safe direction here: the
 * consequence is an older link, not a missing screen.
 */
import { configVersionOf } from '../config-versions/config-version.js';
import { firstAnswer } from '../config-versions/within-budget.js';
import type { AdminClient } from './admin-client.js';
import type { LegalDocument } from './namespaces/legal-documents.js';

const CACHE_TTL_MS = 60_000;

/**
 * How long a tap on a locale never read yet waits for the panel before it
 * answers "no documents". The budget of a message's words in the bot
 * (`bot/lib/config-within.ts`).
 */
export const LEGAL_DOCUMENTS_WAIT_BUDGET_MS = 1_000;

interface Entry {
  readonly documents: readonly LegalDocument[];
  readonly fetchedAt: number;
  /** The answer's version (`config-version.ts`), for the version poll. */
  readonly version: string;
  /** Kept across `invalidate()`: served while the edit is read. */
  readonly superseded: boolean;
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

  public constructor(
    private readonly fetchFn: (locale: string) => Promise<readonly LegalDocument[]>,
    private readonly ttlMs: number = CACHE_TTL_MS,
    private readonly waitBudgetMs: number = LEGAL_DOCUMENTS_WAIT_BUDGET_MS,
  ) {}

  public async get(locale: string): Promise<readonly LegalDocument[]> {
    const cached = this.values.get(locale);
    if (cached !== undefined) {
      const due = cached.superseded || Date.now() - cached.fetchedAt >= this.ttlMs;
      if (due && !this.inFlight.has(locale)) void this.startRefresh(locale);
      return cached.documents;
    }
    const startedAt = this.generation;
    const pending = this.inFlight.get(locale) ?? this.startRefresh(locale);
    if (this.budgetSpent.get(locale) === startedAt) return [];
    const first = await firstAnswer({ fetched: pending, budgetMs: this.waitBudgetMs });
    if (first !== null) return first;
    if (startedAt === this.generation) this.budgetSpent.set(locale, startedAt);
    return [];
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

  /** Starts one fetch for `locale` and holds its slot until it settles. Never rejects. */
  private startRefresh(locale: string): Promise<readonly LegalDocument[]> {
    const refresh = this.refresh(locale, this.generation);
    this.inFlight.set(locale, refresh);
    void refresh.finally(() => {
      // After an invalidate the slot may already hold a newer fetch.
      if (this.inFlight.get(locale) === refresh) this.inFlight.delete(locale);
    });
    return refresh;
  }

  private async refresh(locale: string, startedAt: number): Promise<readonly LegalDocument[]> {
    try {
      const fresh = await this.fetchFn(locale);
      if (startedAt === this.generation) {
        this.values.set(locale, {
          documents: fresh,
          fetchedAt: Date.now(),
          version: configVersionOf(fresh),
          superseded: false,
        });
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
      return [];
    }
  }
}

let cache: LegalDocumentsCache | null = null;

/** Process-wide cache bound to the given client on first use. */
export function getLegalDocumentsCache(adminClient: AdminClient): LegalDocumentsCache {
  cache ??= new LegalDocumentsCache((locale) => adminClient.legalDocuments.list(locale));
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
