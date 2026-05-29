/**
 * Partner namespace — partner-tier info, lightweight active-status probe
 * (used by the bottom-nav to pick Referral vs Partner tab), earnings,
 * withdrawal history and withdrawal creation.
 *
 * Identity: path-templated endpoints accept a `UserIdentity` and forward
 * the best available reference (reiwa_id preferred, telegramId fallback);
 * the upstream resolves either to the canonical reiwa_id. The
 * lightweight `getStatus` keeps its query-string shape.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface CreateWithdrawalInput {
  readonly amount: number;
  readonly method: string;
  readonly requisites: string;
}

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

function identityQuery(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return `userId=${encodeURIComponent(identity.userId)}`;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return `telegramId=${encodeURIComponent(identity.telegramId)}`;
  }
  return '';
}

export class PartnerNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getInfo(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/partner/info`,
    );
  }

  /**
   * Lightweight partner-status check used by the reiwa bottom-nav to
   * decide between the Referral and the Partner tab. Avoids heavy joins
   * (earnings/withdrawals) and is safe to call on every dashboard mount.
   */
  getStatus(identity: UserIdentity): Promise<{ isActive: boolean }> {
    return this.transport.request<{ isActive: boolean }>(
      'GET',
      `/api/internal/user/partner-status?${identityQuery(identity)}`,
    );
  }

  getEarnings(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/partner/earnings`,
    );
  }

  getWithdrawals(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/partner/withdrawals`,
    );
  }

  createWithdrawal(identity: UserIdentity, data: CreateWithdrawalInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/partner/withdraw`,
      data,
    );
  }
}
