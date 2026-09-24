import { describe, expect, it } from 'vitest';

import { addCurrencyAmounts, formatCurrencyAmount } from '../../web/src/features/renewal/renewal-review-policy.js';

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
