import { describe, expect, it } from 'vitest';

import {
  normalizeWireDecimal,
  resolveRenewalCheckoutError,
} from '../../src/api/routes/payments-errors.js';
import { UpstreamError } from '../../src/core/errors/upstream-error.js';

describe('renewal checkout wire decimals', () => {
  it('normalizes scientific notation to the canonical decimal wire form', () => {
    expect(normalizeWireDecimal('1e-8')).toBe('0.00000001');
    expect(normalizeWireDecimal('1.2300e+2')).toBe('123');
  });

  it('rejects malformed or negative amounts', () => {
    expect(normalizeWireDecimal('-1e-8')).toBeNull();
    expect(normalizeWireDecimal('not-a-number')).toBeNull();
  });
});

describe('renewal checkout error contract', () => {
  it('preserves the three actionable public error codes without leaking upstream detail', () => {
    expect(
      resolveRenewalCheckoutError(
        new UpstreamError('POST', '/internal', 409, JSON.stringify({ code: 'QUOTE_CHANGED' })),
      ),
    ).toEqual({
      status: 409,
      body: {
        code: 'QUOTE_CHANGED',
        message: 'Renewal quote changed; refresh the review before paying',
      },
    });
    expect(
      resolveRenewalCheckoutError(
        new UpstreamError('POST', '/internal', 409, JSON.stringify({ code: 'IDEMPOTENCY_KEY_CONFLICT' })),
      ),
    ).toEqual({
      status: 409,
      body: {
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'This retry key belongs to a different renewal. Start checkout again.',
      },
    });
    expect(
      resolveRenewalCheckoutError(
        new UpstreamError('POST', '/internal', 502, JSON.stringify({ code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED' })),
      ),
    ).toEqual({
      status: 502,
      body: {
        code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
        message: 'Payment creation status is unresolved. Check payment status before retrying.',
      },
    });
  });

  it('maps an unknown renewal conflict to the safe quote-changed contract', () => {
    expect(resolveRenewalCheckoutError(new UpstreamError('POST', '/internal', 409, 'provider secret'))).toEqual({
      status: 409,
      body: {
        code: 'QUOTE_CHANGED',
        message: 'Renewal quote changed; refresh the review before paying',
      },
    });
  });
});
