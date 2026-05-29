/**
 * Devices namespace — list and delete VPN-bound device records (HWIDs).
 *
 * The upstream `InternalUserDevicesController` resolves the path
 * reference (`:userRef`) to the canonical reiwa_id — it accepts either a
 * reiwa_id (CUID, web / web-first users) or a telegramId. Callers pass a
 * `UserIdentity` and we forward the best available reference.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class DevicesNamespace {
  constructor(private readonly transport: AdminTransport) {}

  list(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/devices`,
    );
  }

  delete(identity: UserIdentity, hwid: string): Promise<unknown> {
    return this.transport.request(
      'DELETE',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/devices/${encodeURIComponent(hwid)}`,
    );
  }
}
