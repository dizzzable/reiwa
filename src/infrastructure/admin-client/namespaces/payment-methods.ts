/**
 * PaymentMethodsNamespace — list, unbind, and toggle autopay for saved methods.
 *
 * Upstream: InternalUserPaymentMethodsController
 *   GET    /api/internal/user/:userRef/payment-methods
 *   DELETE /api/internal/user/:userRef/payment-methods/:methodId
 *   PATCH  /api/internal/user/:userRef/payment-methods/:methodId  { autopayEnabled }
 *
 * Unbind is local soft-deactivate (YooKassa has no detach-card API).
 * Autopay toggle keeps the card bound but blocks off-session charge.
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

export class PaymentMethodsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  list(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/payment-methods`,
    );
  }

  unbind(identity: UserIdentity, methodId: string): Promise<unknown> {
    return this.transport.request(
      'DELETE',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/payment-methods/${encodeURIComponent(methodId)}`,
    );
  }

  setAutopay(
    identity: UserIdentity,
    methodId: string,
    autopayEnabled: boolean,
  ): Promise<unknown> {
    return this.transport.request(
      'PATCH',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/payment-methods/${encodeURIComponent(methodId)}`,
      { autopayEnabled },
    );
  }
}
