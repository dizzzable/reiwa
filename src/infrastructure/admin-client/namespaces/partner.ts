/**
 * Partner namespace — partner-tier info, lightweight active-status probe
 * (used by the bottom-nav to pick Referral vs Partner tab), earnings,
 * withdrawal history and withdrawal creation.
 */
import type { AdminTransport } from '../transport.js';

export interface CreateWithdrawalInput {
  readonly amount: number;
  readonly method: string;
  readonly requisites: string;
}

export class PartnerNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getInfo(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${telegramId}/partner/info`,
    );
  }

  /**
   * Lightweight partner-status check used by the reiwa bottom-nav to
   * decide between the Referral and the Partner tab. Avoids heavy joins
   * (earnings/withdrawals) and is safe to call on every dashboard mount.
   */
  getStatus(telegramId: string): Promise<{ isActive: boolean }> {
    return this.transport.request<{ isActive: boolean }>(
      'GET',
      `/api/internal/user/partner-status?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  getEarnings(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${telegramId}/partner/earnings`,
    );
  }

  getWithdrawals(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${telegramId}/partner/withdrawals`,
    );
  }

  createWithdrawal(telegramId: string, data: CreateWithdrawalInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${telegramId}/partner/withdraw`,
      data,
    );
  }
}
