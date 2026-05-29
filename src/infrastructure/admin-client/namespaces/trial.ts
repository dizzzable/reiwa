/**
 * Trial namespace — eligibility check + activation. Trial flows are
 * orthogonal enough from regular paid subscriptions (different rate
 * limits, different abuse-detection policy) to warrant their own
 * namespace.
 *
 * Identity: accepts a `UserIdentity`. The upstream endpoints resolve
 * either a reiwa_id (CUID) or telegramId, so web-only users can claim a
 * trial too.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

function identityQuery(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return `userId=${encodeURIComponent(identity.userId)}`;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return `telegramId=${encodeURIComponent(identity.telegramId)}`;
  }
  return '';
}

function identityBody(identity: UserIdentity): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    body['userId'] = identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    body['telegramId'] = identity.telegramId;
  }
  return body;
}

export class TrialNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getEligibility(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/trial/eligibility?${identityQuery(identity)}`,
    );
  }

  activate(identity: UserIdentity): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/user/trial', identityBody(identity));
  }
}
