import { describe, expect, it } from 'vitest';

import { createRenewalIdempotencyKey } from '../../web/src/features/renewal/renewal-idempotency.js';

describe('renewal idempotency key', () => {
  it('is stable for retries within one checkout attempt', () => {
    const draft = {
      subscriptionIds: ['sub-2', 'sub-1'],
      gatewayType: 'YOOKASSA',
      quote: { amount: '1e-8', currency: 'USD' },
      durations: [{ subscriptionId: 'sub-1', days: 30 }],
      plans: [],
      addOns: [{ subscriptionId: 'sub-1', addOnIds: ['addon-1'] }],
    } as const;

    const first = createRenewalIdempotencyKey(draft, 'attempt-1');
    const retry = createRenewalIdempotencyKey({ ...draft }, 'attempt-1');
    const reordered = createRenewalIdempotencyKey(
      { ...draft, subscriptionIds: ['sub-1', 'sub-2'] },
      'attempt-1',
    );

    expect(first).toBe(retry);
    expect(reordered).toBe(first);
    expect(createRenewalIdempotencyKey(draft, 'attempt-2')).not.toBe(first);
  });

  it('changes when a checkout-defining field changes', () => {
    const base = {
      subscriptionIds: ['sub-1'],
      gatewayType: 'YOOKASSA',
      quote: { amount: '1.00', currency: 'USD' },
      durations: [],
      plans: [],
      addOns: [],
    } as const;

    expect(createRenewalIdempotencyKey(base, 'attempt-1')).not.toBe(
      createRenewalIdempotencyKey({ ...base, gatewayType: 'STRIPE' }, 'attempt-1'),
    );
  });
});
