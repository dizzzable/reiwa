import express from 'express';
import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { createDeviceSignalsRouter } from '../../src/api/routes/device-signals.js';

/**
 * The edge half of the device-signal report.
 *
 * Two properties are worth more here than any individual assertion, and each
 * has its own case below.
 *
 * THE IDENTITY COMES FROM THE SESSION. A payload that named its own user would
 * let anybody attach a device to somebody else's account — and for a signal
 * whose whole job is to link accounts together, that is a way to get a stranger
 * marked as a ban evader.
 *
 * THE ANSWER NEVER VARIES. The mark this can raise is only worth having while
 * the person carrying it cannot tell. A 404 for an unknown account or a 500 for
 * a dead upstream is a probe for exactly that.
 */

interface Captured {
  readonly userId: string;
  readonly installId: string | null;
  readonly deviceHash: string | null;
}

function makeApp(options: {
  readonly userId?: string | null;
  readonly upstreamThrows?: boolean;
  /** A legacy Telegram session and no reiwa_id — the bot/Mini App shape. */
  readonly telegramOnly?: boolean;
} = {}) {
  const captured: Captured[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (options.telegramOnly === true) {
      req.cookies = { reiwa_session: 'legacy-session' };
    } else if (options.userId !== null && options.userId !== undefined) {
      req.webSession = {
        userId: options.userId,
        createdAt: Date.now(),
        ip: '127.0.0.1',
        lastActivity: Date.now(),
      };
      req.webSessionId = 'session-1';
    }
    next();
  });
  app.use(
    '/api/v1',
    createDeviceSignalsRouter({
      adminClient: {
        user: {
          reportDeviceSignals: async (input: Captured) => {
            if (options.upstreamThrows === true) throw new Error('upstream is down');
            captured.push(input);
            return { ok: true };
          },
        },
      } as never,
      sessionStore:
        options.telegramOnly === true
          ? ({
              get: async () => ({ telegramId: '123456789' }),
              refresh: async () => undefined,
            } as never)
          : null,
    }),
  );
  return { app, captured };
}


/**
 * Posts a JSON body against a real listener.
 *
 * The same shape the other route tests here use, and for the same reason:
 * driving the router through an actual HTTP round-trip is what proves the
 * response the CLIENT sees, which for this route is the entire contract.
 */
async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const payload = JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          let raw = '';
          response.on('data', (chunk) => (raw += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
describe('POST /device-signals', () => {
  it('forwards the signals under the session identity', async () => {
    const { app, captured } = makeApp({ userId: 'user-1' });

    const response = await postJson(app, '/api/v1/device-signals', {
      installId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      deviceHash: 'f00dcafe1234',
    });
    expect(response).toEqual({ status: 200, body: { ok: true } });

    expect(captured).toEqual([
      {
        userId: 'user-1',
        installId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        deviceHash: 'f00dcafe1234',
      },
    ]);
  });

  it('ignores a user id the caller supplied for themselves', async () => {
    // The load-bearing case. Trusting the body would let anybody plant their
    // own device on somebody else's account and get that person flagged.
    const { app, captured } = makeApp({ userId: 'user-1' });

    const response = await postJson(app, '/api/v1/device-signals', {
      userId: 'somebody-else',
      installId: 'aaaaaaaa-bbbb-cccc-dddd-ee',
    });
    expect(response).toEqual({ status: 200, body: { ok: true } });

    expect(captured[0].userId).toBe('user-1');
  });

  it('answers the same thing when the upstream is down', async () => {
    // A varying answer is a probe for "did that report land". It also must not
    // become an error the customer sees: this runs in the background, and a
    // device signal is worth less than any request they actually made.
    const { app } = makeApp({ userId: 'user-1', upstreamThrows: true });

    const response = await postJson(app, '/api/v1/device-signals', {
      installId: 'aaaaaaaa-bbbb-cccc-dddd-ee',
    });
    expect(response).toEqual({ status: 200, body: { ok: true } });
  });

  it('spends no upstream call on a report with nothing in it', async () => {
    // A hardened browser produces neither value. Forwarding that would be a
    // round-trip to tell the panel nothing.
    const { app, captured } = makeApp({ userId: 'user-1' });

    const response = await postJson(app, '/api/v1/device-signals', {});
    expect(response).toEqual({ status: 200, body: { ok: true } });

    expect(captured).toEqual([]);
  });

  it('skips a Telegram-only caller and still answers ok', async () => {
    // A Telegram surface has no canonical reiwa_id on the request, and needs
    // none: it already carries a Telegram id, which is a stronger signal than
    // anything a browser can derive about the machine. The answer stays
    // identical so the skip is not itself something to detect.
    const { app, captured } = makeApp({ telegramOnly: true });

    const response = await postJson(app, '/api/v1/device-signals', {
      installId: 'aaaaaaaa-bbbb-cccc-dddd-ee',
    });
    expect(response).toEqual({ status: 200, body: { ok: true } });

    expect(captured).toEqual([]);
  });

  it('refuses a caller with no session at all', async () => {
    // The one place the answer DOES vary, and it varies before this route
    // runs: the shared session middleware refuses an unauthenticated caller
    // exactly as it does on every other route. That is not a leak — it says
    // nothing about any account, only that nobody is signed in.
    const { app, captured } = makeApp({ userId: null });

    const response = await postJson(app, '/api/v1/device-signals', {
      installId: 'aaaaaaaa-bbbb-cccc-dddd-ee',
    });
    expect(response.status).toBe(401);

    expect(captured).toEqual([]);
  });
});
