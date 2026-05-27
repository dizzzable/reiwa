/**
 * Push namespace — Web Push subscribe / unsubscribe used by the SPA
 * service worker.
 */
import type { AdminTransport } from '../transport.js';

export interface WebPushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export class PushNamespace {
  constructor(private readonly transport: AdminTransport) {}

  subscribe(
    userId: string,
    subscription: WebPushSubscriptionPayload,
  ): Promise<{ success: boolean }> {
    return this.transport.request<{ success: boolean }>(
      'POST',
      '/api/internal/push/subscribe',
      { userId, subscription },
    );
  }

  unsubscribe(userId: string, endpoint: string): Promise<{ success: boolean }> {
    return this.transport.request<{ success: boolean }>(
      'DELETE',
      '/api/internal/push/unsubscribe',
      { userId, endpoint },
    );
  }
}
