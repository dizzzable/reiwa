import { describe, it, expect } from 'vitest';

import { AddOnsNamespace } from '../../src/infrastructure/admin-client/namespaces/add-ons.js';

function namespaceWith(request: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return request(method, path, body);
    },
  };
  return { namespace: new AddOnsNamespace(transport as never), calls };
}

const VALID_ELIGIBILITY = {
  contractVersion: 2,
  availability: 'AVAILABLE',
  target: { subscriptionId: 'sub-1', termId: 'term-1', planId: 'plan-1' },
  addOns: [
    {
      id: 'addon-1',
      revision: 3,
      name: 'Extra 50GB',
      description: null,
      type: 'EXTRA_TRAFFIC',
      icon: '📶',
      value: 50,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      eligibility: { eligible: true, activation: 'NOW', expiresAt: '2027-01-01T00:00:00.000Z', explanationCode: 'ELIGIBLE_UNTIL_SUBSCRIPTION_END' },
      prices: [{ currency: 'USD', price: '2.50' }],
    },
  ],
};

const VALID_CHECKOUT = {
  paymentId: 'pay-1',
  transactionStatus: 'PENDING',
  gatewayType: 'YOOKASSA',
  purchaseType: 'ADDITIONAL',
  amount: '2.50',
  currency: 'USD',
  checkoutUrl: 'https://pay/1',
  providerMode: 'REDIRECT',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * A traffic reset, exactly as the panel emits it.
 *
 * Three fields differ from every other add-on and all three were rejected by the
 * first version of the schema: the type itself, a `null` lifetime (a reset
 * grants nothing, so it expires at no time), and the `freeAllowance` block. A
 * rejected payload does not degrade — zod throws and the WHOLE options screen
 * goes blank for every customer, the moment an operator creates their first
 * reset add-on.
 */
const RESET_ELIGIBILITY = {
  ...VALID_ELIGIBILITY,
  addOns: [
    {
      id: 'addon-reset',
      revision: 1,
      name: 'Сброс трафика',
      description: null,
      type: 'RESET_TRAFFIC',
      icon: '🔄',
      value: 0,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      eligibility: {
        eligible: true,
        activation: 'NOW',
        expiresAt: null,
        explanationCode: 'RESET_TRAFFIC_IMMEDIATE',
      },
      freeAllowance: { freeUsesPerTerm: 1, usedThisTerm: 0, freeRemaining: 1, isFree: true },
      prices: [{ currency: 'USD', price: '1.00' }],
    },
  ],
};

describe('AddOnsNamespace v2 contract (T-014)', () => {
  it('parses a traffic reset: new type, null expiry, free allowance', async () => {
    const { namespace } = namespaceWith(async () => RESET_ELIGIBILITY);

    const result = await namespace.listForSubscription('sub-1', {});

    expect(result.addOns[0]?.type).toBe('RESET_TRAFFIC');
    expect(result.addOns[0]?.eligibility.expiresAt).toBeNull();
    expect(result.addOns[0]?.freeAllowance?.isFree).toBe(true);
  });

  it('still parses a reset from a panel that predates the allowance field', async () => {
    // The two ship as separate images. A cabinet newer than its API must show a
    // price rather than blank the screen.
    const older = {
      ...RESET_ELIGIBILITY,
      addOns: [
        Object.fromEntries(
          Object.entries(RESET_ELIGIBILITY.addOns[0]!).filter(([k]) => k !== 'freeAllowance'),
        ),
      ],
    };
    const { namespace } = namespaceWith(async () => older);

    const result = await namespace.listForSubscription('sub-1', {});

    expect(result.addOns[0]?.type).toBe('RESET_TRAFFIC');
  });

  it('parses a valid v2 eligibility payload and hits the subscription-scoped path', async () => {
    const { namespace, calls } = namespaceWith(async () => VALID_ELIGIBILITY);
    const result = await namespace.listForSubscription('sub-1');
    expect(result.contractVersion).toBe(2);
    expect(result.availability).toBe('AVAILABLE');
    expect(result.addOns[0]?.eligibility.activation).toBe('NOW');
    expect(result.addOns[0]?.icon).toBe('📶');
    expect(calls[0]?.path).toBe('/api/internal/add-ons/subscriptions/sub-1');
  });

  it('forwards the caller identity as query params so the backend can scope ownership', async () => {
    const byUser = namespaceWith(async () => VALID_ELIGIBILITY);
    await byUser.namespace.listForSubscription('sub-1', { userId: 'u-7' });
    expect(byUser.calls[0]?.path).toBe('/api/internal/add-ons/subscriptions/sub-1?userId=u-7');

    const byTelegram = namespaceWith(async () => VALID_ELIGIBILITY);
    await byTelegram.namespace.listForSubscription('sub-1', { telegramId: '42' });
    expect(byTelegram.calls[0]?.path).toBe(
      '/api/internal/add-ons/subscriptions/sub-1?telegramId=42',
    );

    // No identity → no query string (trusted/in-process shape).
    const none = namespaceWith(async () => VALID_ELIGIBILITY);
    await none.namespace.listForSubscription('sub-1', {});
    expect(none.calls[0]?.path).toBe('/api/internal/add-ons/subscriptions/sub-1');
  });

  it('accepts an EMPTY availability with no add-ons', async () => {
    const { namespace } = namespaceWith(async () => ({
      contractVersion: 2,
      availability: 'EMPTY',
      target: null,
      addOns: [],
    }));
    const result = await namespace.listForSubscription('sub-1');
    expect(result.availability).toBe('EMPTY');
    expect(result.addOns).toHaveLength(0);
  });

  it('rejects a malformed eligibility payload (wrong contract version)', async () => {
    const { namespace } = namespaceWith(async () => ({ ...VALID_ELIGIBILITY, contractVersion: 1 }));
    await expect(namespace.listForSubscription('sub-1')).rejects.toThrow();
  });

  it('rejects an eligibility payload with an unknown add-on type', async () => {
    const bad = {
      ...VALID_ELIGIBILITY,
      addOns: [{ ...VALID_ELIGIBILITY.addOns[0], type: 'EXTRA_MYSTERY' }],
    };
    const { namespace } = namespaceWith(async () => bad);
    await expect(namespace.listForSubscription('sub-1')).rejects.toThrow();
  });

  it('propagates an upstream outage instead of collapsing to empty', async () => {
    const { namespace } = namespaceWith(async () => {
      throw new Error('upstream 503');
    });
    await expect(namespace.listForSubscription('sub-1')).rejects.toThrow('upstream 503');
  });

  it('forwards the idempotency key + pinned revision and validates the checkout result', async () => {
    const { namespace, calls } = namespaceWith(async () => VALID_CHECKOUT);
    const result = await namespace.purchase({
      identity: { userId: 'user-1' },
      addOnId: 'addon-1',
      subscriptionId: 'sub-1',
      gatewayType: 'YOOKASSA',
      idempotencyKey: 'intent-key-1',
      expectedAddOnRevision: 3,
      contractVersion: 2,
    });
    expect(result.paymentId).toBe('pay-1');
    expect(result.checkoutUrl).toBe('https://pay/1');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.idempotencyKey).toBe('intent-key-1');
    expect(body.expectedAddOnRevision).toBe(3);
    expect(body.contractVersion).toBe(2);
  });

  it('rejects a malformed checkout result', async () => {
    const { namespace } = namespaceWith(async () => ({ paymentId: 'pay-1' }));
    await expect(
      namespace.purchase({ identity: { userId: 'u' }, addOnId: 'a', subscriptionId: 's', gatewayType: 'YOOKASSA' }),
    ).rejects.toThrow();
  });
});
