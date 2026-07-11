/**
 * QuestsNamespace partner (Phase C) contract test.
 *
 * The cabinet manual-code / timed-visit methods are user-scoped: identity comes
 * from the BFF session (reiwa_id or telegramId), never from the browser body.
 * They go through the shared signed transport and hit the internal partner
 * endpoints with a server-resolved reference.
 */
import { describe, expect, it } from 'vitest';

import { QuestsNamespace } from '../../../src/infrastructure/admin-client/namespaces/quests.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeTransport() {
  const calls: Call[] = [];
  const transport = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { state: 'COMPLETED' };
    },
  };
  return { transport, calls };
}

describe('QuestsNamespace partner surface', () => {
  it('submits a manual code with a server-resolved reiwa_id reference', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.submitPartnerCode({ userId: 'cmphfcr6i007v01jg0lcu653h' }, 'cmpquest0000000000000abcd', 'PROMO2026');

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/quests/partner/code',
      body: { userRef: 'cmphfcr6i007v01jg0lcu653h', questId: 'cmpquest0000000000000abcd', code: 'PROMO2026' },
    });
  });

  it('falls back to telegramId when no reiwa_id is present', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.submitPartnerCode({ telegramId: '42' }, 'cmpquest0000000000000abcd', 'CODE');

    expect((calls[0].body as { userRef: string }).userRef).toBe('42');
  });

  it('starts a timed visit', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.startPartnerVisit({ userId: 'cmphfcr6i007v01jg0lcu653h' }, 'cmpquest0000000000000abcd');

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/quests/partner/visit/start',
      body: { userRef: 'cmphfcr6i007v01jg0lcu653h', questId: 'cmpquest0000000000000abcd' },
    });
  });

  it('confirms a timed visit', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.confirmPartnerVisit({ userId: 'cmphfcr6i007v01jg0lcu653h' }, 'cmpquest0000000000000abcd');

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/quests/partner/visit/complete',
      body: { userRef: 'cmphfcr6i007v01jg0lcu653h', questId: 'cmpquest0000000000000abcd' },
    });
  });

  it('throws when no identity is present', () => {
    const { transport } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);
    expect(() => ns.submitPartnerCode({}, 'q', 'c')).toThrow();
  });
});
