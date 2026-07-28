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
});
