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
 * Failure returns an EMPTY list, which the caller reads as "no documents" and
 * falls back to the legacy rules link. That is the safe direction here: the
 * consequence is an older link, not a missing screen.
 */
import type { AdminClient } from './admin-client.js';
import type { LegalDocument } from './namespaces/legal-documents.js';

const CACHE_TTL_MS = 60_000;

export class LegalDocumentsCache {
  private readonly values = new Map<string, { documents: readonly LegalDocument[]; fetchedAt: number }>();
  private readonly inFlight = new Map<string, Promise<readonly LegalDocument[]>>();

  public constructor(
    private readonly fetchFn: (locale: string) => Promise<readonly LegalDocument[]>,
    private readonly ttlMs: number = CACHE_TTL_MS,
  ) {}

  public async get(locale: string): Promise<readonly LegalDocument[]> {
    const cached = this.values.get(locale);
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.documents;
    }
    const pending = this.inFlight.get(locale);
    if (pending !== undefined) {
      return pending;
    }
    const refresh = this.refresh(locale);
    this.inFlight.set(locale, refresh);
    try {
      return await refresh;
    } finally {
      this.inFlight.delete(locale);
    }
  }

  /** Drops every locale so the next read refetches. Called on the operator webhook. */
  public invalidate(): void {
    this.values.clear();
  }

  private async refresh(locale: string): Promise<readonly LegalDocument[]> {
    try {
      const fresh = await this.fetchFn(locale);
      this.values.set(locale, { documents: fresh, fetchedAt: Date.now() });
      return fresh;
    } catch {
      const stale = this.values.get(locale);
      if (stale !== undefined) {
        // Last-known-good, with the clock reset so an outage is not hammered
        // once per tap.
        this.values.set(locale, { documents: stale.documents, fetchedAt: Date.now() });
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

/** Drops the cached documents; wired to the same operator-edit webhook as the policy cache. */
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
