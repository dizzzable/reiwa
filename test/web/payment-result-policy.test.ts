import { describe, expect, it } from 'vitest';

import { resolvePaymentResult } from '../../web/src/features/payment/payment-result-policy.js';

describe('payment result matrix', () => {
  it('treats COMPLETED with or without a provider URL as success', () => {
    expect(resolvePaymentResult({ status: 'COMPLETED', checkoutUrl: 'https://pay.test' })).toBe('success');
    expect(resolvePaymentResult({ status: 'COMPLETED', checkoutUrl: null })).toBe('success');
  });

  it('keeps PENDING with no URL in processing, never failed', () => {
    expect(resolvePaymentResult({ status: 'PENDING', checkoutUrl: null })).toBe('processing');
  });

  it('surfaces provider-unresolved as unresolved instead of creating another checkout', () => {
    expect(
      resolvePaymentResult({ status: 'PENDING', checkoutUrl: null, errorCode: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED' }),
    ).toBe('unresolved');
  });
});
