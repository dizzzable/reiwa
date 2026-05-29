/**
 * FAQ namespace — operator-managed help articles surfaced on the SPA
 * settings → FAQ page. Items are locale-filtered upstream; `null`
 * locale entries are global fallbacks.
 */
import type { AdminTransport } from '../transport.js';

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly mediaUrls: readonly string[];
  readonly orderIndex: number;
  readonly locale: string | null;
}

export class FaqNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Returns active FAQ items for the given locale (plus global
   * `null`-locale entries). Omit `locale` to get every active item.
   */
  getPublicFaq(locale?: string | null): Promise<readonly FaqItem[]> {
    const query =
      locale !== undefined && locale !== null && locale.length > 0
        ? `?locale=${encodeURIComponent(locale)}`
        : '';
    return this.transport.request<readonly FaqItem[]>(
      'GET',
      `/api/internal/faq${query}`,
    );
  }
}
