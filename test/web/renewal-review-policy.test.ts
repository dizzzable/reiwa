import { describe, expect, it } from 'vitest';

import {
  addCurrencyAmounts,
  formatCurrencyAmount,
  resolveRenewalAddOnReview,
} from '../../web/src/features/renewal/renewal-review-policy.js';

const traffic = {
  id: 'traffic-10',
  name: '10 GB',
  type: 'EXTRA_TRAFFIC' as const,
  value: 10,
  prices: [{ currency: 'USD', price: '2.50' }],
};

const readyQuery = {
  isLoading: false,
  isFetching: false,
  isError: false,
  data: { availability: 'AVAILABLE' as const, addOns: [traffic] },
};

function resolve(overrides: Partial<Parameters<typeof resolveRenewalAddOnReview>[0]> = {}) {
  return resolveRenewalAddOnReview({
    selectedSubscriptionIds: ['sub-1'],
    selectedAddOns: { 'sub-1': ['traffic-10'] },
    currency: 'USD',
    eligibilityQueries: [readyQuery],
    ...overrides,
  });
}

describe('resolveRenewalAddOnReview', () => {
  it('stays pending while required eligibility has not settled', () => {
    expect(resolve({ eligibilityQueries: [{ ...readyQuery, isLoading: true }] }).status).toBe('PENDING');
    expect(resolve({ eligibilityQueries: [{ ...readyQuery, isFetching: true }] }).status).toBe('PENDING');
  });

  it('fails closed on query error or unavailable eligibility', () => {
    expect(resolve({ eligibilityQueries: [{ ...readyQuery, isError: true }] }).status).toBe('ERROR');
    expect(
      resolve({
        eligibilityQueries: [{ ...readyQuery, data: { availability: 'DISABLED' as const, addOns: [] } }],
      }).status,
    ).toBe('ERROR');
  });

  it('fails closed when a selected id or gateway-currency price cannot be resolved', () => {
    expect(resolve({ selectedAddOns: { 'sub-1': ['removed-id'] } }).status).toBe('ERROR');
    expect(
      resolve({
        eligibilityQueries: [{
          ...readyQuery,
          data: { availability: 'AVAILABLE' as const, addOns: [{ ...traffic, prices: [{ currency: 'EUR', price: '2.50' }] }] },
        }],
      }).status,
    ).toBe('ERROR');
  });

  it('returns fully resolved lines and their all-in add-on total', () => {
    const result = resolve();
    expect(result.status).toBe('READY');
    expect(result.lines).toEqual([{ subscriptionId: 'sub-1', addOn: traffic, price: '2.50' }]);
    expect(result.addOnTotal).toBe('2.5');
    expect(result.allowsPartnerBalance).toBe(false);
  });

  it('allows partner balance only when the review is base-only', () => {
    const result = resolveRenewalAddOnReview({
      selectedSubscriptionIds: ['sub-1'],
      selectedAddOns: {},
      currency: 'USD',
      eligibilityQueries: [],
    });
    expect(result).toMatchObject({ status: 'READY', lines: [], addOnTotal: '0', allowsPartnerBalance: true });
  });
});

describe('currency amount arithmetic', () => {
  it('adds decimal strings exactly without binary floating-point drift', () => {
    expect(addCurrencyAmounts(['0.1', '0.2'])).toBe('0.3');
  });

  it('preserves all supported eight decimal places and displays significant crypto precision', () => {
    expect(addCurrencyAmounts(['0.00000001', '1.00000001'])).toBe('1.00000002');
    expect(formatCurrencyAmount('0.00000001')).toBe('0.00000001');
    expect(formatCurrencyAmount('1')).toBe('1.00');
    expect(formatCurrencyAmount('1.23000000')).toBe('1.23');
  });

  it('fails closed when an amount exceeds the database precision contract', () => {
    expect(addCurrencyAmounts(['0.000000001'])).toBeNull();
  });
});
