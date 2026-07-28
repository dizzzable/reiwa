import { describe, expect, it, vi } from 'vitest';

import { TariffConstructorNamespace } from '../../../src/infrastructure/admin-client/namespaces/tariff-constructor.js';

describe('TariffConstructorNamespace', () => {
  it('parses the exact manifest and quote contract', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ contractVersion: 1, revisionId: 'r1', revision: 2, durations: [{ days: 30, currency: 'RUB', baseAmount: '100.00' }], modules: [{ type: 'DEVICES', min: 1, max: 5, defaultValue: 2, step: 1, prices: [{ days: 30, currency: 'RUB', perStepAmount: '10.00' }] }] })
      .mockResolvedValueOnce({ contractVersion: 1, revisionId: 'r1', durationDays: 30, currency: 'RUB', lines: [{ kind: 'BASE', amount: '100.00' }, { kind: 'MODULE', module: 'DEVICES', value: 2, steps: 1, perStepAmount: '10.00', amount: '10.00' }], total: '110.00' });
    const namespace = new TariffConstructorNamespace({ request } as never);
    const manifest = await namespace.getManifest();
    await expect(namespace.quote({ revisionId: manifest.revisionId, durationDays: 30, currency: 'RUB', selections: [{ type: 'DEVICES', value: 2 }] })).resolves.toEqual({ contractVersion: 1, revisionId: 'r1', durationDays: 30, currency: 'RUB', lines: [{ kind: 'BASE', amount: '100.00' }, { kind: 'MODULE', module: 'DEVICES', value: 2, steps: 1, perStepAmount: '10.00', amount: '10.00' }], total: '110.00' });
    expect(request).toHaveBeenLastCalledWith('POST', '/api/internal/tariff-constructor/quote', expect.not.objectContaining({ userId: expect.anything(), prices: expect.anything() }));
  });

  it('rejects unknown response fields and non-decimal amounts', async () => {
    const namespace = new TariffConstructorNamespace({ request: vi.fn().mockResolvedValue({ contractVersion: 1, revisionId: 'r1', revision: 1, durations: [{ days: 30, currency: 'RUB', baseAmount: 100 }], modules: [], extra: true }) } as never);
    await expect(namespace.getManifest()).rejects.toThrow();
  });

  it('rejects the old quote line shape and missing quote context', async () => {
    const namespace = new TariffConstructorNamespace({ request: vi.fn().mockResolvedValue({ contractVersion: 1, lines: [{ type: 'BASE', amount: '100.00' }], total: '100.00' }) } as never);
    await expect(namespace.quote({ revisionId: 'r1', durationDays: 30, currency: 'RUB', selections: [] })).rejects.toThrow();
  });

  it('adds only trusted identity to checkout and validates the exact payment response', async () => {
    const request = vi.fn().mockResolvedValue({ paymentId: 'pay-1', transactionStatus: 'PENDING', gatewayType: 'YOOKASSA', purchaseType: 'NEW', amount: '110.00', currency: 'RUB', checkoutUrl: 'https://pay.example/1', providerMode: 'REDIRECT', createdAt: '2026-07-28T00:00:00.000Z' });
    const namespace = new TariffConstructorNamespace({ request } as never);
    await expect(namespace.checkout({ userId: 'user-1' }, { revisionId: 'r1', durationDays: 30, currency: 'RUB', selections: [], purchaseType: 'NEW', gatewayType: 'YOOKASSA', channel: 'WEB', idempotencyKey: 'key-1', expectedAmount: '110.00', expectedCurrency: 'RUB', successUrl: 'https://reiwa.example/payment-return', failUrl: 'https://reiwa.example/payment-return' })).resolves.toMatchObject({ paymentId: 'pay-1', purchaseType: 'NEW' });
    expect(request).toHaveBeenCalledWith('POST', '/api/internal/tariff-constructor/checkout', expect.objectContaining({ userId: 'user-1', idempotencyKey: 'key-1' }));
  });

  it.each([
    ['TELEGRAM_INVOICE', null],
    ['IMMEDIATE', null],
    ['NONE', null],
  ] as const)('accepts %s checkout with a null replay URL', async (providerMode, checkoutUrl) => {
    const request = vi.fn().mockResolvedValue({ paymentId: 'pay-1', transactionStatus: 'PENDING', gatewayType: 'TELEGRAM_STARS', purchaseType: 'NEW', amount: '110.00', currency: 'XTR', checkoutUrl, providerMode, createdAt: '2026-07-28T00:00:00.000Z' });
    const namespace = new TariffConstructorNamespace({ request } as never);
    await expect(namespace.checkout({ userId: 'user-1' }, { revisionId: 'r1', durationDays: 30, currency: 'XTR', selections: [], purchaseType: 'NEW', gatewayType: 'TELEGRAM_STARS', channel: 'TELEGRAM', idempotencyKey: 'key-1', expectedAmount: '110.00', expectedCurrency: 'XTR', successUrl: 'https://reiwa.example/payment-return', failUrl: 'https://reiwa.example/payment-return' })).resolves.toMatchObject({ providerMode, checkoutUrl: null });
  });
});
