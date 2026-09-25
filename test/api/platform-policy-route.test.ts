import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createProfileRouter } from '../../src/api/routes/profile.js';
import {
  PolicyCache,
  setPolicyCache,
} from '../../src/infrastructure/admin-client/policy-cache.js';
import type { PlatformPolicyShape } from '../../src/infrastructure/admin-client/namespaces/system.js';
import { configVersionOf } from '../../src/infrastructure/config-versions/config-version.js';
import type { LastKnownGoodStorePort } from '../../src/infrastructure/config-versions/last-known-good.js';

/**
 * GET /api/v1/platform-policy (W8 report D4).
 *
 * It asked the panel on every cabinet load — ten seconds on a hanging panel,
 * and ten more on the SPA's retry — and answered `{}` on any failure. The SPA
 * reads `{}` as access mode PUBLIC with the claim gate and subscription-link
 * recovery off, so an outage silently dropped the operator's access mode. Now
 * it is the process's `PolicyCache`: the last known policy on a failure, from
 * memory or from the copy in Redis, and 503 — never an invented policy — when
 * none was ever known.
 */

const RESTRICTED: PlatformPolicyShape = {
  accessMode: 'RESTRICTED',
  rulesRequired: false,
  rulesLink: null,
  channelRequired: false,
  channelLink: null,
  defaultCurrency: 'RUB',
  subscriptionLinkRecovery: true,
};

function app(): express.Express {
  const application = express();
  application.use(
    '/api/v1',
    createProfileRouter({ adminClient: null, sessionStore: null, config: { NODE_ENV: 'test' } as never }),
  );
  return application;
}

async function get(application: express.Express): Promise<{ status: number; body: unknown; cacheControl?: string }> {
  const server = http.createServer(application);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/v1/platform-policy' }, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown, cacheControl: res.headers['cache-control'] }),
          );
        })
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('GET /api/v1/platform-policy', () => {
  beforeEach(() => setPolicyCache(null));
  afterEach(() => {
    setPolicyCache(null);
    vi.restoreAllMocks();
  });

  it('answers the policy the panel gave, from the process’s policy cache — one panel read for many loads', async () => {
    const fetchPolicy = vi.fn(async () => RESTRICTED);
    setPolicyCache(new PolicyCache(fetchPolicy));

    const first = await get(app());
    const second = await get(app());

    expect(first).toEqual({ status: 200, body: RESTRICTED, cacheControl: 'no-store' });
    expect(second.body).toEqual(RESTRICTED);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it('answers the last known policy when the panel fails later — never `{}`', async () => {
    const fetchPolicy = vi
      .fn<() => Promise<PlatformPolicyShape>>()
      .mockResolvedValueOnce(RESTRICTED)
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    const cache = new PolicyCache(fetchPolicy);
    setPolicyCache(cache);
    await get(app());
    cache.invalidate();

    const res = await get(app());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESTRICTED);
  });

  it('a restart with the panel down answers the policy saved in Redis', async () => {
    const store: LastKnownGoodStorePort = {
      load: vi.fn(async () => ({
        shape: 1,
        savedAt: 1,
        hash: configVersionOf(RESTRICTED),
        payload: { ...RESTRICTED },
      })) as LastKnownGoodStorePort['load'],
      save: vi.fn(async () => 'saved' as const) as LastKnownGoodStorePort['save'],
    };
    setPolicyCache(
      new PolicyCache(
        async () => {
          throw new Error('connect ECONNREFUSED');
        },
        { lastKnownGood: store },
      ),
    );

    const res = await get(app());

    expect(res).toEqual({ status: 200, body: RESTRICTED, cacheControl: 'no-store' });
  });

  it('answers 503 when no policy was ever known — not a PUBLIC one it made up', async () => {
    setPolicyCache(
      new PolicyCache(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );

    const res = await get(app());

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: 'Platform policy unavailable' });
    expect(res.cacheControl).toBe('no-store');
  });

  it('answers 503 on a cabinet with no panel configured at all', async () => {
    // The singleton, built by the route itself around no client.
    const res = await get(app());
    expect(res.status).toBe(503);
  });
});
