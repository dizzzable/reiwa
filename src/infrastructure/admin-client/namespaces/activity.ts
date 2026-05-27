/**
 * Activity namespace — transactions ledger + notification inbox (list,
 * unread count, mark-one-read, mark-all-read). The bot dashboard and
 * the SPA notifications drawer both consume from here.
 */
import type { AdminTransport } from '../transport.js';

export class ActivityNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getTransactions(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/transactions?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  getNotifications(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/notifications?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  getUnreadCount(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/notifications/unread-count?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  markAllRead(telegramId: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/user/notifications/read-all', {
      telegramId,
    });
  }

  markRead(telegramId: string, notificationId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/notifications/${encodeURIComponent(notificationId)}/read`,
      { telegramId },
    );
  }
}
