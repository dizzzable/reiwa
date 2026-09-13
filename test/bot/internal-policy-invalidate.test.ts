/**
 * `/invalidate-policy` — the bot process's copies of the platform policy and the
 * legal documents, dropped when the operator changes either.
 *
 * The panel's `reiwa.platform.policy_invalidated` webhook lands in reiwa-api,
 * which is not this process: the bot runs in its own container (`reiwa-bot` in
 * docker-compose.yml). Both caches are per-process singletons, and the
 * legal-documents one is only ever built here, so dropping them over there never
 * reached the bot — it kept enforcing the old access mode, or offering the old
 * rules link, until the 60s TTL ran out. The API now relays the event to this
 * route, and what is measured here is the bot's half: the SAME singletons the
 * bot's pages read through `getPolicyCache` / `getLegalDocumentsCache` go
 * upstream again on their next read.
 *
 * Measured on upstream call counts, not the status: a 204 from a route that
 * dropped nothing looks exactly like a 204 from one that did. The listener runs
 * on a real socket with real internal-HMAC headers, and with `bot: null,
 * cache: null` — dropping a cache needs neither a Telegram client nor the
 * bot-config cache, so it must not wait for either.
 */
import http from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startInternalHttpListener } from '../../src/bot/listeners/internal-http-listener.js';
import type { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
import {
  LegalDocumentsCache,
  getLegalDocumentsCache,
  setLegalDocumentsCache,
} from '../../src/infrastructure/admin-client/legal-documents-cache.js';
import type { LegalDocument } from '../../src/infrastructure/admin-client/namespaces/legal-documents.js';
import type { PlatformPolicyShape } from '../../src/infrastructure/admin-client/namespaces/system.js';
import {
  PolicyCache,
  getPolicyCache,
  setPolicyCache,
} from '../../src/infrastructure/admin-client/policy-cache.js';
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from '../../src/lib/internal-hmac.js';

const SECRET = 's'.repeat(32);
const PATH = '/invalidate-policy';

type ListenerOptions = Parameters<typeof startInternalHttpListener>[0];

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ListenerOptions['logger'];

const POLICY: PlatformPolicyShape = {
  accessMode: 'RESTRICTED',
  rulesRequired: true,
  rulesLink: null,
  channelRequired: false,
  channelLink: null,
  defaultCurrency: 'USD',
};

const DOCUMENTS: readonly LegalDocument[] = [
  { key: 'USER_AGREEMENT', title: 'Пользовательское соглашение', body: 'текст' },
];

interface Harness {
  /** POST `/invalidate-policy` at the live listener; resolves with its status. */
  readonly call: (opts?: { readonly signed?: boolean }) => Promise<number>;
  readonly close: () => Promise<void>;
}

function startHarness(): Harness {
  const server = startInternalHttpListener({
    bot: null,
    cache: null,
    secret: SECRET,
    port: 0,
    logger: silentLogger,
  });
  if (server === null) throw new Error('listener did not start');
  const ready = once(server, 'listening');

  const call = async ({ signed = true }: { readonly signed?: boolean } = {}): Promise<number> => {
    await ready;
    const { port } = server.address() as { port: number };
    const raw = JSON.stringify({ reason: 'platform.accessMode' });
    const auth: Record<string, string> = {};
    if (signed) {
      const { timestamp, signature } = buildInternalSignature({
        secret: SECRET,
        method: 'POST',
        path: PATH,
        body: raw,
      });
      auth[REQUEST_TIMESTAMP_HEADER] = timestamp;
      auth[REQUEST_SIGNATURE_HEADER] = signature;
    }
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: PATH,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            connection: 'close',
            ...auth,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(raw);
    });
  };

  const close = async (): Promise<void> => {
    await ready;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { call, close };
}

/**
 * Install WARM process-wide caches, the ones the bot's pages read, and hand back
 * their upstream counters.
 */
async function warmBotCaches() {
  const policyUpstream = vi.fn(async () => POLICY);
  const documentsUpstream = vi.fn(async (_locale: string) => DOCUMENTS);
  const policy = new PolicyCache(policyUpstream);
  const documents = new LegalDocumentsCache(documentsUpstream);
  setPolicyCache(policy);
  setLegalDocumentsCache(documents);
  for (let read = 0; read < 2; read += 1) {
    await policy.get();
    await documents.get('ru');
  }
  // Anchor: warm. A cache that never cached would "go upstream again" below for
  // a reason that has nothing to do with the route.
  expect(policyUpstream).toHaveBeenCalledTimes(1);
  expect(documentsUpstream).toHaveBeenCalledTimes(1);
  return { policy, documents, policyUpstream, documentsUpstream };
}

describe('bot /invalidate-policy', () => {
  afterEach(() => {
    // Process-wide singletons: leave none behind for the next case.
    setPolicyCache(null);
    setLegalDocumentsCache(null);
    vi.restoreAllMocks();
  });

  it('drops both caches the bot reads, on a signed call', async () => {
    const warm = await warmBotCaches();
    const harness = startHarness();
    try {
      expect(await harness.call()).toBe(204);

      await warm.policy.get();
      await warm.documents.get('ru');
      expect(warm.policyUpstream).toHaveBeenCalledTimes(2);
      expect(warm.documentsUpstream).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it('refuses an unsigned call and leaves both caches warm', async () => {
    // The listener's port is reachable from the docker network; an unsigned
    // POST that could drop these would let anything on it force a panel read
    // per request.
    const warm = await warmBotCaches();
    const harness = startHarness();
    try {
      expect(await harness.call({ signed: false })).toBe(401);

      await warm.policy.get();
      await warm.documents.get('ru');
      expect(warm.policyUpstream).toHaveBeenCalledTimes(1);
      expect(warm.documentsUpstream).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it('answers 204 before any page has read either cache, and binds neither to no client', async () => {
    // An operator's save can easily land before the first subscriber tap after
    // a bot restart. The route has no admin client to build a cache with, and a
    // cache built without one never recovers: every later read through the
    // accessor gets that same instance, whose fetch throws, so the policy reads
    // as the PUBLIC fallback and the documents as an empty list — for as long
    // as the process lives.
    setPolicyCache(null);
    setLegalDocumentsCache(null);
    const harness = startHarness();
    try {
      expect(await harness.call()).toBe(204);
    } finally {
      await harness.close();
    }

    // The pages' first reads, with the client the bot really has.
    const getPlatformPolicy = vi.fn(async () => POLICY);
    const list = vi.fn(async (_locale?: string | null) => DOCUMENTS);
    const adminClient = {
      system: { getPlatformPolicy },
      legalDocuments: { list },
    } as unknown as AdminClient;

    expect(await getPolicyCache(adminClient).get()).toEqual(POLICY);
    expect(await getLegalDocumentsCache(adminClient).get('ru')).toEqual(DOCUMENTS);
    expect(getPlatformPolicy).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
