import http from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PublicConfigPersistencePort,
  PublicConfigSnapshot,
} from '../../src/application/ports/public-config-persistence.port.js';
import { isPublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import {
  createBrandingRouter,
  resetBrandingCache,
} from '../../src/api/routes/branding.js';
import { DEFAULT_PUBLIC_CONFIG } from '../../web/src/types/branding.js';

const OPERATOR_PUBLIC_CONFIG: PublicConfigSnapshot = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: '/uploads/branding/northern-lights.svg',
    pwaIconUrl: '/uploads/branding/northern-lights.png',
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
    cardLogo: 'CUSTOM',
    cardLogoUrl: '/uploads/branding/card-logo.svg',
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 0.7,
    cardEffectsByIndex: [],
    bgEffect: 'AURORA',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
  emailEnabled: true,
};

const REIWA_OWNED_TARGETS = {
  supportUsername: 'ReiwaSupport',
  botUsername: 'ReiwaBot',
  webBaseUrl: 'https://reiwa.example',
};

function createMemoryPersistence(
  initialSnapshot: PublicConfigSnapshot | null = null,
): PublicConfigPersistencePort & {
  readonly load: ReturnType<typeof vi.fn>;
  readonly save: ReturnType<typeof vi.fn>;
} {
  let snapshot = initialSnapshot;
  return {
    load: vi.fn(async () => snapshot),
    save: vi.fn(async (next: PublicConfigSnapshot) => {
      snapshot = next;
    }),
  };
}

function makeApp(
  getReiwaPublicConfig: () => Promise<PublicConfigSnapshot>,
  publicConfigPersistence: PublicConfigPersistencePort,
): express.Express {
  const app = express();
  app.use(
    '/api/v1',
    createBrandingRouter({
      adminClient: {
        branding: { getReiwaPublicConfig },
      } as never,
      publicConfigPersistence,
      supportUsername: '@ReiwaSupport',
      botUsername: '@ReiwaBot',
      webBaseUrl: 'https://reiwa.example/',
    }),
  );
  return app;
}

async function request(app: express.Express, path: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    return await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${path}`, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

describe('public branding configuration routes', () => {
  beforeEach(() => resetBrandingCache());

  afterEach(() => {
    vi.restoreAllMocks();
    resetBrandingCache();
  });

  it('publishes the Reiwa-owned targets used by advertising deep links', async () => {
    const app = makeApp(
      vi.fn(async () => OPERATOR_PUBLIC_CONFIG),
      createMemoryPersistence(),
    );

    const response = await request(app, '/api/v1/public-config');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(REIWA_OWNED_TARGETS);
  });

  it('serves the last successful public config after Rezeis becomes unavailable', async () => {
    const persistence = createMemoryPersistence();
    const firstApp = makeApp(
      vi.fn(async () => OPERATOR_PUBLIC_CONFIG),
      persistence,
    );

    const initialResponse = await request(firstApp, '/api/v1/public-config');
    expect(initialResponse.status).toBe(200);
    expect(persistence.save).toHaveBeenCalledWith(OPERATOR_PUBLIC_CONFIG);

    // This mirrors a Reiwa restart or a branding-invalidate webhook: the
    // in-memory cache is empty, but the durable last-known-good snapshot is
    // still available while Rezeis is down.
    resetBrandingCache();
    const unavailableApp = makeApp(
      vi.fn(async () => {
        throw new Error('Rezeis unavailable');
      }),
      persistence,
    );

    const fallbackResponse = await request(unavailableApp, '/api/v1/public-config');

    expect(fallbackResponse.status).toBe(200);
    expect(fallbackResponse.body).toEqual({
      ...OPERATOR_PUBLIC_CONFIG,
      ...REIWA_OWNED_TARGETS,
    });
  });

  it('uses Reiwa defaults only when Rezeis fails before any snapshot exists', async () => {
    const persistence = createMemoryPersistence();
    const app = makeApp(
      vi.fn(async () => {
        throw new Error('Rezeis unavailable');
      }),
      persistence,
    );

    const response = await request(app, '/api/v1/public-config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ...DEFAULT_PUBLIC_CONFIG,
      ...REIWA_OWNED_TARGETS,
    });
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invalid card effect slot',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          cardEffectsByIndex: [
            { cardEffect: 'aurora', cardEffectProps: {}, cardEffectOpacity: 'opaque' },
          ],
        },
      },
    ],
    [
      'invalid app background texture',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          appBackground: {
            kind: 'texture',
            effect: 'NONE',
            props: {},
            opacity: 1,
            gradient: '',
            texture: {
              pattern: 'dots',
              color: '#fff',
              background: '#000',
              scale: 'large',
              opacity: 0.2,
            },
          },
        },
      },
    ],
    [
      'invalid custom icon',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        customIcons: [{ id: 'signal', name: 'Signal', url: 42, color: null }],
      },
    ],
    [
      'invalid plan card settings',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          planCardStyles: { starter: { cardEffectProps: [] } },
        },
      },
    ],
    [
      'invalid navigation entry',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          navItems: [{ id: 'plans', visible: 'yes' }],
        },
      },
    ],
    [
      'invalid platform branding',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        platformBranding: { projectName: {}, webTitle: null },
      },
    ],
  ])('rejects a persisted snapshot with %s', (_label, malformed) => {
    expect(isPublicConfigSnapshot(malformed)).toBe(false);
  });

  it('does not serve a malformed injected persistence snapshot during an outage', async () => {
    const malformedPersistence = createMemoryPersistence({
      ...OPERATOR_PUBLIC_CONFIG,
      customIcons: [{ id: 'signal', name: 'Signal', url: 42, color: null }],
    } as unknown as PublicConfigSnapshot);
    const app = makeApp(
      vi.fn(async () => {
        throw new Error('Rezeis unavailable');
      }),
      malformedPersistence,
    );

    const response = await request(app, '/api/v1/public-config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ...DEFAULT_PUBLIC_CONFIG,
      ...REIWA_OWNED_TARGETS,
    });
  });
});
