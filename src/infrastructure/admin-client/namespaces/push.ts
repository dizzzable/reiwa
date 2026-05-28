/**
 * Push namespace — Web Push subscribe / unsubscribe used by the SPA
 * service worker.
 *
 * `getPublicKey()` returns the operator-configured VAPID public key
 * the SPA hands to the PushManager during subscription. Empty string
 * means push is disabled (no keys configured) and the SPA should
 * hide its push opt-in UI.
 */
import type { AdminTransport } from '../transport.js';

export interface WebPushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface PushPublicKeyResult {
  readonly publicKey: string;
}

export class PushNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getPublicKey(): Promise<PushPublicKeyResult> {
    return this.transport.request<PushPublicKeyResult>(
      'GET',
      '/api/internal/push/public-key',
    );
  }

  subscribe(
    userId: string,
    subscription: WebPushSubscriptionPayload,
    userAgent?: string,
  ): Promise<{ success: boolean }> {
    return this.transport.request<{ success: boolean }>(
      'POST',
      '/api/internal/push/subscribe',
      { userId, subscription, userAgent },
    );
  }

  unsubscribe(userId: string, endpoint: string): Promise<{ success: boolean }> {
    return this.transport.request<{ success: boolean }>(
      'POST',
      '/api/internal/push/unsubscribe',
      { userId, endpoint },
    );
  }
}
