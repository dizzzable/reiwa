import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { apiLimiter } from '../../src/api/middleware/rate-limit.js';

/**
 * `GET /api/v1/config-versions` is not counted against the 120-a-minute
 * per-address `/api` budget (review R2a-10, CD2a §8.3).
 *
 * Every visible tab asks it once a minute, and it is answered from the
 * process's memory. Counted, a carrier NAT address with a hundred open cabinets
 * behind it spent the budget on the version check alone, and the customers'
 * real calls got 429. Mounted exactly as `api/app.ts` mounts it (`/api`).
 */

async function withApp(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api', apiLimiter);
  app.get('/api/v1/config-versions', (_req, res) => {
    res.json({ versions: {} });
  });
  app.get('/api/v1/plans', (_req, res) => {
    res.json([]);
  });
  app.post('/api/v1/config-versions', (_req, res) => {
    res.json({});
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/api/v1`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('the /api budget and the settings version check (review R2a-10)', () => {
  it('130 version checks from one address all pass, and leave the budget of the real calls whole', async () => {
    await withApp(async (base) => {
      for (let ask = 0; ask < 130; ask += 1) {
        const res = await fetch(`${base}/config-versions${ask % 2 === 0 ? '' : '?t=1'}`);
        expect(res.status).toBe(200);
      }
      // Anchor: the budget is live — and whole: 120 real calls pass, the next is refused.
      for (let call = 0; call < 120; call += 1) {
        expect((await fetch(`${base}/plans`)).status).toBe(200);
      }
      expect((await fetch(`${base}/plans`)).status).toBe(429);
      // Still skipped with the budget spent.
      expect((await fetch(`${base}/config-versions`)).status).toBe(200);
      // Only the GET of that exact path: anything else is counted as before.
      expect((await fetch(`${base}/config-versions`, { method: 'POST' })).status).toBe(429);
      expect((await fetch(`${base}/config-versions-other`)).status).toBe(429);
    });
  });
});
