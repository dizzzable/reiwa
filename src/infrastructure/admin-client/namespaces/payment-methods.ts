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

  startSetup(
    identity: UserIdentity,
    input: { readonly returnUrl: string; readonly consent: boolean },
    clientContext?: { readonly clientIp?: string | null; readonly userAgent?: string | null },
  ): Promise<unknown> {
    // Forward the end-user's client hints so rezeis can audit the consent
    // context (the socket IP it sees is reiwa's, not the user's).
    const extraHeaders: Record<string, string> = {};
    if (clientContext?.clientIp) {
      extraHeaders['x-forwarded-for'] = clientContext.clientIp;
    }
    if (clientContext?.userAgent) {
      extraHeaders['x-client-user-agent'] = clientContext.userAgent;
    }
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/payment-methods/setup`,
      input,
      Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    );
  }

  getSetupStatus(identity: UserIdentity, setupId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/payment-methods/setup/${encodeURIComponent(setupId)}`,
    );
  }
}
