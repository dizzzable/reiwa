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

/**
 * The documents an operator can switch on, in the order every surface
 * renders them: what the service is, what it does with your data, what you
 * are paying for.
 *
 * A CONSTANT and not a bare union, because the registration route validates
 * the accepted list against it. When the panel gained a third document and
 * this had only two, the validator would refuse every registration that
 * ticked the new one — a total sign-up outage caused by an operator
 * publishing a privacy policy.
 */
export const LEGAL_DOCUMENT_KEYS = ['USER_AGREEMENT', 'PRIVACY_POLICY', 'OFFER'] as const;

export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_KEYS)[number];

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
