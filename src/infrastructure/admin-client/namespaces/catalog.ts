/**
 * Catalog namespace — public plan list (subscription tiers, durations,
 * pricing tables) consumed by the bot `/plans` command and the SPA
 * catalog page.
 */
import type { AdminTransport } from '../transport.js';

export class CatalogNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getPublicPlans(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/catalog/plans');
  }
}
