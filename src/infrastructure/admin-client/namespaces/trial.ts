/**
 * Trial namespace — eligibility check + activation. Trial flows are
 * orthogonal enough from regular paid subscriptions (different rate
 * limits, different abuse-detection policy) to warrant their own
 * namespace.
 */
import type { AdminTransport } from '../transport.js';

export class TrialNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getEligibility(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/trial/eligibility?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  activate(telegramId: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/user/trial', { telegramId });
  }
}
