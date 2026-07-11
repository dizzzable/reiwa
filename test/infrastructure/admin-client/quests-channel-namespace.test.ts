/**
 * QuestsNamespace channel (Phase B) contract test.
 *
 * The bot verification surface must go through the shared signed transport
 * (Bearer + HMAC) and hit the internal channel endpoints with exactly the
 * server-trusted fields — Telegram id + quest id only, never a browser userId.
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
      return { ok: true };
    },
  };
  return { transport, calls };
}

describe('QuestsNamespace channel surface', () => {
  it('fetches server-derived channel target with telegram id + quest id only', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.channelTarget({ telegramId: '123456789', questId: 'quest-1' });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/internal/quests/channel/target',
        body: { telegramId: '123456789', questId: 'quest-1' },
      },
    ]);
  });

  it('records a fresh positive membership proof via the verify endpoint', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.verifyChannel({ telegramId: '123456789', questId: 'quest-1' });

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/quests/channel/verify',
      body: { telegramId: '123456789', questId: 'quest-1' },
    });
  });

  it('reports a periodic membership recheck result', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.recheckChannel({ telegramId: '123456789', questId: 'quest-1', isMember: false });

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/quests/channel/recheck',
      body: { telegramId: '123456789', questId: 'quest-1', isMember: false },
    });
  });

  it('lists bot recheck candidates', async () => {
    const { transport, calls } = fakeTransport();
    const ns = new QuestsNamespace(transport as never);

    await ns.channelRecheckCandidates();

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/internal/quests/channel/recheck/candidates',
      body: {},
    });
  });
});
