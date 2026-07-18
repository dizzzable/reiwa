import { describe, expect, it } from 'vitest';

import { PaymentsNamespace } from '../../src/infrastructure/admin-client/namespaces/payments.js';

describe('PaymentsNamespace.createRenewalCheckout channel contract', () => {
  it('forwards Telegram as the payment channel for Mini App renewals', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport = {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return { paymentId: 'payment-1' };
      },
    };

    await new PaymentsNamespace(transport as never).createRenewalCheckout(
      { userId: 'user-1' },
      {
        subscriptionIds: ['subscription-1'],
        gatewayType: 'YOOKASSA',
        channel: 'TELEGRAM',
      },
    );

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/payments/renewal-checkout',
      body: {
        subscriptionIds: ['subscription-1'],
        gatewayType: 'YOOKASSA',
        userId: 'user-1',
        channel: 'TELEGRAM',
      },
    });
  });
});
