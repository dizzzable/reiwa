/**
 * Devices namespace — list and delete VPN-bound device records (HWIDs).
 *
 * The upstream `InternalUserDevicesController` works off the
 * rezeis-admin `User.id` (CUID). Reiwa keeps `telegramId` everywhere on
 * the wire and the upstream translates via the `?telegramId=` query so
 * callers don't have to resolve the user themselves.
 */
import type { AdminTransport } from '../transport.js';

export class DevicesNamespace {
  constructor(private readonly transport: AdminTransport) {}

  list(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/devices?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  delete(telegramId: string, hwid: string): Promise<unknown> {
    return this.transport.request(
      'DELETE',
      `/api/internal/user/devices/${encodeURIComponent(hwid)}?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }
}
