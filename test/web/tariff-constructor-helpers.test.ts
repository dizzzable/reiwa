import { describe, expect, it } from 'vitest';

import { clearCheckoutAttempt, initialQuoteRequest, loadCheckoutAttempt, quoteCompositionKey, reconcileQuoteRequest, resolveCheckoutAttempt, saveCheckoutAttempt, updateSelection } from '../../web/src/features/constructor/helpers.js';

describe('tariff constructor helpers', () => {
  const manifest = { contractVersion: 1 as const, revisionId: 'r2', revision: 2, durations: [{ days: 30, currency: 'RUB', baseAmount: '100.00' }], modules: [{ type: 'TRAFFIC' as const, min: 10, max: 100, defaultValue: 30, step: 10, prices: [] }] };

  it('uses only server defaults and quote identifiers', () => {
    expect(initialQuoteRequest(manifest)).toEqual({ revisionId: 'r2', durationDays: 30, currency: 'RUB', selections: [{ type: 'TRAFFIC', value: 30 }] });
  });

  it('updates a selection without adding prices', () => {
    expect(updateSelection(initialQuoteRequest(manifest), 'TRAFFIC', 40)).toMatchObject({ selections: [{ type: 'TRAFFIC', value: 40 }] });
  });

  it('keeps one idempotency key across retries and replaces it when composition changes', () => {
    const request = initialQuoteRequest(manifest);
    const first = resolveCheckoutAttempt(undefined, request, () => 'first');
    expect(resolveCheckoutAttempt(first, request, () => 'second')).toBe(first);
    const changed = updateSelection(request, 'TRAFFIC', 40);
    expect(resolveCheckoutAttempt(first, changed, () => 'second')).toEqual({ compositionKey: quoteCompositionKey(changed), idempotencyKey: 'second' });
  });

  it('replaces the idempotency key when the gateway changes', () => {
    const request = initialQuoteRequest(manifest);
    const first = resolveCheckoutAttempt(undefined, request, () => 'first', 'YOOKASSA');
    expect(resolveCheckoutAttempt(first, request, () => 'second', 'CRYPTOPAY')).toEqual({ compositionKey: quoteCompositionKey(request, 'CRYPTOPAY'), idempotencyKey: 'second' });
  });

  it('preserves the request on a same-revision manifest refetch', () => {
    const selected = updateSelection(initialQuoteRequest(manifest), 'TRAFFIC', 70);
    expect(reconcileQuoteRequest(selected, { ...manifest })).toEqual({ request: selected, changed: false });
  });

  it('reconciles duration and snaps values when the revision changes', () => {
    const previous = updateSelection(initialQuoteRequest(manifest), 'TRAFFIC', 90);
    const nextManifest = { ...manifest, revisionId: 'r3', revision: 3, durations: [{ days: 60, currency: 'USD', baseAmount: '2.00' }], modules: [{ ...manifest.modules[0]!, min: 20, max: 75, step: 20 }] };
    expect(reconcileQuoteRequest(previous, nextManifest)).toEqual({ request: { revisionId: 'r3', durationDays: 60, currency: 'USD', selections: [{ type: 'TRAFFIC', value: 75 }] }, changed: true });
  });

  it('persists, restores and clears a bounded checkout attempt without composition details outside its key', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    const request = initialQuoteRequest(manifest);
    const attempt = resolveCheckoutAttempt(undefined, request, () => 'attempt-1');
    saveCheckoutAttempt(storage, attempt);
    expect(loadCheckoutAttempt(storage, request)).toEqual(attempt);
    expect(loadCheckoutAttempt(storage, updateSelection(request, 'TRAFFIC', 40))).toBeUndefined();
    clearCheckoutAttempt(storage);
    expect(loadCheckoutAttempt(storage, request)).toBeUndefined();
  });
});
