import { describe, expect, it } from 'vitest';

import { canRenewSubscription } from '../../web/src/features/dashboard/components/subscription-action-policy.js';
import type { Subscription } from '../../web/src/types/api.js';

function subscription(
  status: Subscription['status'],
  input: { readonly isTrial?: boolean; readonly trialFree?: boolean } = {},
): Subscription {
  return {
    id: 'subscription-1',
    status,
    isTrial: input.isTrial ?? false,
    trialFree: input.trialFree,
  } as Subscription;
}

describe('subscription renewal action policy', () => {
  it.each(['ACTIVE', 'LIMITED', 'EXPIRED'] as const)(
    'keeps regular %s subscriptions renewable',
    (status) => {
      expect(canRenewSubscription(subscription(status), false, true)).toBe(true);
    },
  );

  it('blocks both free and paid trials from renewal', () => {
    expect(
      canRenewSubscription(
        subscription('EXPIRED', { isTrial: true, trialFree: true }),
        false,
        true,
      ),
    ).toBe(false);
    expect(
      canRenewSubscription(
        subscription('EXPIRED', { isTrial: true, trialFree: false }),
        false,
        true,
      ),
    ).toBe(false);
  });

  it('keeps restricted mode and non-renewable statuses blocked', () => {
    expect(canRenewSubscription(subscription('ACTIVE'), true, true)).toBe(false);
    expect(canRenewSubscription(subscription('DELETED'), false, true)).toBe(false);
    expect(canRenewSubscription(null, false, true)).toBe(false);
  });

  it('fails closed when isTrial or the exact backend policy is missing', () => {
    const missingTrialMarker = {
      ...subscription('ACTIVE'),
      isTrial: undefined,
    } as unknown as Subscription;

    expect(canRenewSubscription(missingTrialMarker, false, true)).toBe(false);
    expect(canRenewSubscription(subscription('ACTIVE'), false, undefined)).toBe(false);
    expect(canRenewSubscription(subscription('ACTIVE'), false, false)).toBe(false);
  });
});
