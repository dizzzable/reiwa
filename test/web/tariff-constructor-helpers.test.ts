import { describe, expect, it } from 'vitest';

import { initialQuoteRequest, updateSelection } from '../../web/src/features/constructor/helpers.js';

describe('tariff constructor helpers', () => {
  const manifest = { contractVersion: 1 as const, revisionId: 'r2', revision: 2, durations: [{ days: 30, currency: 'RUB', baseAmount: '100.00' }], modules: [{ type: 'TRAFFIC' as const, min: 10, max: 100, defaultValue: 30, step: 10, prices: [] }] };

  it('uses only server defaults and quote identifiers', () => {
    expect(initialQuoteRequest(manifest)).toEqual({ revisionId: 'r2', durationDays: 30, currency: 'RUB', selections: [{ type: 'TRAFFIC', value: 30 }] });
  });

  it('updates a selection without adding prices', () => {
    expect(updateSelection(initialQuoteRequest(manifest), 'TRAFFIC', 40)).toMatchObject({ selections: [{ type: 'TRAFFIC', value: 40 }] });
  });
});
