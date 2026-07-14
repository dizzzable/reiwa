import { describe, it, expect } from 'vitest';

import { PaymentsNamespace } from '../../src/infrastructure/admin-client/namespaces/payments.js';

function namespaceWith() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { paymentId: 'pay-1', checkoutUrl: 'https://pay/1' };
    },
  };
  return { namespace: new PaymentsNamespace(transport as never), calls };
}

describe('PaymentsNamespace.createRenewalCheckout add-on forwarding (T-015)', () => {
  it('forwards non-empty addOns + idempotencyKey to the renewal-checkout endpoint', async () => {
    const { namespace, calls } = namespaceWith();
    await namespace.createRenewalCheckout(
      { userId: 'user-1' },
      {
        subscriptionIds: ['s1', 's2'],
        gatewayType: 'YOOKASSA',
        channel: 'WEB',
        addOns: [
          { subscriptionId: 's1', addOnIds: ['a-traffic', 'a-devices'] },
          { subscriptionId: 's2', addOnIds: ['a-traffic'] },
        ],
        expectedAmount: '17.50',
        expectedCurrency: 'USD',
        idempotencyKey: 'idem-1',
      },
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/api/internal/payments/renewal-checkout');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['addOns']).toEqual([
      { subscriptionId: 's1', addOnIds: ['a-traffic', 'a-devices'] },
      { subscriptionId: 's2', addOnIds: ['a-traffic'] },
    ]);
    expect(body['idempotencyKey']).toBe('idem-1');
    expect(body['expectedAmount']).toBe('17.50');
    expect(body['expectedCurrency']).toBe('USD');
    expect(body['userId']).toBe('user-1');
  });

  it('omits addOns/idempotencyKey when not provided or empty (dormant by default)', async () => {
    const { namespace, calls } = namespaceWith();
    await namespace.createRenewalCheckout(
      { telegramId: '42' },
      {
        subscriptionIds: ['s1'],
        gatewayType: 'YOOKASSA',
        expectedAmount: '10.00',
        expectedCurrency: 'USD',
        addOns: [],
      },
    );
    const body = calls[0]?.body as Record<string, unknown>;
    expect('addOns' in body).toBe(false);
    expect('idempotencyKey' in body).toBe(false);
    expect(body['telegramId']).toBe('42');
  });
});
