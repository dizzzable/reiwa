/**
 * Catalog namespace — public plan list (subscription tiers, durations,
 * pricing tables) consumed by the bot `/plans` command and the SPA
 * catalog page.
 *
 * Identity-aware: when a `UserIdentity` is supplied, it is forwarded so
 * rezeis resolves the catalog per user context — surfacing context-scoped
 * plans (NEW / EXISTING / INVITED) and paid TRIAL plans, which the
 * anonymous catalog (only `availability=ALL`) hides. Absence of an identity
 * yields the anonymous catalog (logged-out browsing).
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

function identityQuery(identity: UserIdentity | undefined): string {
  if (identity === undefined) return '';
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return `?userId=${encodeURIComponent(identity.userId)}`;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return `?telegramId=${encodeURIComponent(identity.telegramId)}`;
  }
  return '';
}

export class CatalogNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getPublicPlans(identity?: UserIdentity): Promise<unknown> {
    return this.transport.request('GET', `/api/internal/catalog/plans${identityQuery(identity)}`);
  }
}
