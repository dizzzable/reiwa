import { describe, expect, it } from 'vitest';

import { selectRenewalReoffer } from '../../web/src/features/renewal/renewal-reoffer.js';
// NOTE: the zustand-backed renewal store (reconcileReoffer/initializeReoffer) is
// exercised only via reiwa/web's own toolchain — importing it here pulls `zustand`,
// which lives in reiwa/web/node_modules, not the backend root where this suite runs.
// The pure re-offer selector below is the money-relevant logic and stays fully covered.

const addOns = [
  {
    id: 'traffic-10',
    type: 'EXTRA_TRAFFIC' as const,
    value: 10,
    prices: [{ currency: 'USD', price: '2.50' }],
  },
  {
    id: 'devices-1',
    type: 'EXTRA_DEVICES' as const,
    value: 1,
    prices: [{ currency: 'EUR', price: '3.00' }],
  },
];

const historyBase = {
  subscriptionId: 'sub-1',
  addOnId: 'traffic-10' as string | null,
  type: 'EXTRA_TRAFFIC' as const,
  valuePerUnit: 10,
  state: 'ACTIVE',
  expiresAt: '2026-08-01T00:00:00.000Z' as string | null,
};

const now = new Date('2026-07-14T00:00:00.000Z');

describe('selectRenewalReoffer', () => {
  it('returns only currently eligible, gateway-priced add-ons active for this subscription', () => {
    const result = selectRenewalReoffer({
      subscriptionId: 'sub-1',
      currency: 'USD',
      history: [
        historyBase,
        { ...historyBase, subscriptionId: 'sub-2' },
        { ...historyBase, addOnId: 'devices-1', type: 'EXTRA_DEVICES', valuePerUnit: 1 },
      ],
      eligibleAddOns: addOns,
      now,
    });

    expect(result.map((entry) => entry.id)).toEqual(['traffic-10']);
  });

  it('excludes terminal states and locally expired ACTIVE or EXPIRING entries', () => {
    const result = selectRenewalReoffer({
      subscriptionId: 'sub-1',
      currency: 'USD',
      history: [
        { ...historyBase, state: 'EXPIRED' },
        { ...historyBase, state: 'REVERSED' },
        { ...historyBase, state: 'ACTIVE', expiresAt: '2026-07-13T23:59:59.999Z' },
        { ...historyBase, state: 'EXPIRING', expiresAt: '2026-07-14T00:00:00.000Z' },
      ],
      eligibleAddOns: addOns,
      now,
    });

    expect(result).toEqual([]);
  });

  it('accepts non-expired EXPIRING entries and null expiry', () => {
    const result = selectRenewalReoffer({
      subscriptionId: 'sub-1',
      currency: 'USD',
      history: [
        { ...historyBase, state: 'EXPIRING', expiresAt: '2026-07-14T00:00:00.001Z' },
        { ...historyBase, state: 'ACTIVE', expiresAt: null },
      ],
      eligibleAddOns: addOns,
      now,
    });

    expect(result.map((entry) => entry.id)).toEqual(['traffic-10']);
  });

  it('uses type and value as a documented fallback only when legacy addOnId is null', () => {
    const legacy = { ...historyBase, addOnId: null };
    const staleCatalogId = { ...historyBase, addOnId: 'removed-id' };

    expect(
      selectRenewalReoffer({
        subscriptionId: 'sub-1',
        currency: 'USD',
        history: [legacy],
        eligibleAddOns: addOns,
        now,
      }).map((entry) => entry.id),
    ).toEqual(['traffic-10']);

    expect(
      selectRenewalReoffer({
        subscriptionId: 'sub-1',
        currency: 'USD',
        history: [staleCatalogId],
        eligibleAddOns: addOns,
        now,
      }),
    ).toEqual([]);
  });

  it('fails closed when history or eligibility is unavailable', () => {
    expect(
      selectRenewalReoffer({
        subscriptionId: 'sub-1',
        currency: 'USD',
        history: null,
        eligibleAddOns: addOns,
        now,
      }),
    ).toEqual([]);
    expect(
      selectRenewalReoffer({
        subscriptionId: 'sub-1',
        currency: 'USD',
        history: [historyBase],
        eligibleAddOns: null,
        now,
      }),
    ).toEqual([]);
  });

});
