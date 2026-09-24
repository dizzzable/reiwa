import { describe, expect, it } from 'vitest';

import {
  canRenewSubscription,
  renewalReasonKey,
} from '../../web/src/features/dashboard/components/subscription-action-policy.js';
import type { Subscription } from '../../web/src/types/api.js';

function subscription(
  status: Subscription['status'],
  input: {
    readonly isTrial?: boolean;
    readonly trialFree?: boolean;
    readonly expiresAt?: string | null;
    readonly expireAt?: string;
  } = {},
): Subscription {
  return {
    id: 'subscription-1',
    status,
    isTrial: input.isTrial ?? false,
    trialFree: input.trialFree,
    ...('expiresAt' in input ? { expiresAt: input.expiresAt } : {}),
    ...('expireAt' in input ? { expireAt: input.expireAt } : {}),
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

  // The owner, 24.09.2026: a subscription with no end date stays without one.
  describe('a subscription with no end date', () => {
    it('is never offered «Продлить», even when an older panel still says RENEW', () => {
      expect(canRenewSubscription(subscription('ACTIVE', { expiresAt: null }), false, true)).toBe(false);
      expect(canRenewSubscription(subscription('LIMITED', { expiresAt: null }), false, true)).toBe(false);
    });

    it('control: a date, or no word about it at all, keeps the renewal', () => {
      expect(
        canRenewSubscription(subscription('ACTIVE', { expiresAt: '2030-01-01T00:00:00.000Z' }), false, true),
      ).toBe(true);
      // The legacy alias alone still carries a date.
      expect(
        canRenewSubscription(subscription('ACTIVE', { expiresAt: null, expireAt: '2030-01-01T00:00:00.000Z' }), false, true),
      ).toBe(true);
      // A payload that leaves the field out says nothing about it.
      expect(canRenewSubscription(subscription('ACTIVE'), false, true)).toBe(true);
    });

    it('is explained as having nothing to renew — by its own date or by the panel', () => {
      expect(renewalReasonKey(subscription('ACTIVE', { expiresAt: null }), undefined)).toBe('renewal.reason.lifetime');
      // The list shows the VPN panel's date for it; the panel's policy knows better.
      expect(
        renewalReasonKey(subscription('ACTIVE', { expiresAt: '2030-01-01T00:00:00.000Z' }), true),
      ).toBe('renewal.reason.lifetime');
      expect(renewalReasonKey(subscription('ACTIVE', { expiresAt: '2030-01-01T00:00:00.000Z' }), false)).toBeNull();
      expect(renewalReasonKey(subscription('ACTIVE'), undefined)).toBeNull();
    });

    it('a trial is still explained as a trial', () => {
      expect(renewalReasonKey(subscription('ACTIVE', { isTrial: true, expiresAt: null }), true)).toBe(
        'renewal.reason.trial',
      );
    });
  });
});
