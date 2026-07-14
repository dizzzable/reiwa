import { describe, expect, it } from 'vitest';

import {
  ActivityNamespace,
  type AddOnEntitlementsResponse,
} from '../../src/infrastructure/admin-client/namespaces/activity.js';

const RESPONSE = {
  entitlements: [
    {
      id: 'ent-1',
      subscriptionId: 'sub-1',
      addOnId: null,
      receiptName: 'Legacy 50 GB',
      type: 'EXTRA_TRAFFIC',
      valuePerUnit: 50,
      quantity: 1,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      state: 'ACTIVE',
      currency: 'USD',
      totalAmount: '2.50',
      purchasedAt: '2026-07-01T00:00:00.000Z',
      activatedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: null,
    },
  ],
} satisfies AddOnEntitlementsResponse;

describe('ActivityNamespace add-on entitlement contract', () => {
  it('returns the typed exact history shape and forwards canonical identity', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const namespace = new ActivityNamespace({
      request: async (method: string, path: string) => {
        calls.push({ method, path });
        return RESPONSE;
      },
    } as never);

    const result: AddOnEntitlementsResponse = await namespace.getAddOnEntitlements({ userId: 'user-1' });

    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/api/internal/user/add-on-entitlements?userId=user-1',
      },
    ]);
    expect(result).toEqual(RESPONSE);
    expect(result.entitlements[0]?.addOnId).toBeNull();
  });
});
