/**
 * Legal documents namespace — the user agreement and the public offer, as the
 * operator wrote them in the panel.
 *
 * Only ACTIVE documents come back, and only in the requested locale: the panel
 * resolves the locale upstream so the sign-up screen carries just the text it
 * will render. That screen is pre-login, on the slowest path a visitor ever
 * takes, and a second copy of a long agreement is pure weight.
 *
 * Bodies are plain text. Nothing here interprets markup, and the cabinet must
 * not either — the registration screen ships without a sanitizer on purpose.
 */
import type { AdminTransport } from '../transport.js';

export type LegalDocumentKey = 'USER_AGREEMENT' | 'OFFER';

export interface LegalDocument {
  readonly key: LegalDocumentKey;
  readonly title: string;
  readonly body: string;
}

export class LegalDocumentsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /** Active documents for the given locale. Empty when the operator enabled none. */
  list(locale?: string | null): Promise<readonly LegalDocument[]> {
    const query =
      locale !== undefined && locale !== null && locale.length > 0
        ? `?locale=${encodeURIComponent(locale)}`
        : '';
    return this.transport.request<readonly LegalDocument[]>(
      'GET',
      `/api/internal/legal-documents${query}`,
    );
  }
}
