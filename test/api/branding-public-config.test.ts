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

const OPERATOR_PUBLIC_CONFIG: PublicConfigSnapshot = {
  branding: {
    themePresetId: 'concept-cz',
    themePresetVersion: 1,
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
    surfaceTheme: {
      foreground: '#fefefe',
      mutedForeground: '#a8b2bd',
      surface: '#101820',
      surfaceHigh: '#182630',
      borderSoft: '#ffffff',
      borderStrong: '#63f0e0',
      surfaceOpacity: 0.64,
      surfaceHighOpacity: 0.78,
      borderSoftOpacity: 0.08,
      borderStrongOpacity: 0.18,
      glassBlurPx: 22,
    },
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

  it('returns 503 when Rezeis fails before any durable snapshot exists', async () => {
    const persistence = createMemoryPersistence();
    const app = makeApp(
      vi.fn(async () => {
        throw new Error('Rezeis unavailable');
      }),
      persistence,
    );

    const response = await request(app, '/api/v1/public-config');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ message: 'Configuration unavailable' });
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it('accepts non-texture and legacy app backgrounds without an unused texture block', () => {
    const nonTextureBackground = {
      kind: 'gradient',
      effect: 'NONE',
      props: {},
      opacity: 1,
      gradient: 'linear-gradient(135deg, #121212, #242424)',
    };
    const modern = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        appBackground: {
          ...nonTextureBackground,
        },
      },
    };
    const legacy = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        appBackground: {
          effect: 'aurora',
          props: {},
          opacity: 0.8,
          gradient: 'linear-gradient(135deg, #121212, #242424)',
        },
      },
    };

    expect(isPublicConfigSnapshot(modern)).toBe(true);
    expect(isPublicConfigSnapshot(legacy)).toBe(true);
  });

  it('accepts safe plan card accent and texture URLs in persisted snapshots', () => {
    const withPlanCardStyles = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        planCardStyles: {
          starter: {
            accent: '#ff8844',
            textureUrl: '/uploads/branding/starter-texture.webp',
            cardEffect: 'aurora',
            cardEffectProps: {},
            cardEffectOpacity: 0.75,
          },
          premium: {
            textureUrl: 'https://cdn.example.com/branding/premium-texture.webp',
          },
        },
      },
    };

    expect(isPublicConfigSnapshot(withPlanCardStyles)).toBe(true);
  });

  it('accepts card-text policy globally and in both concept brightness variants', () => {
    const baseVariant = {
      primary: '#6750a4',
      primaryFg: '#ffffff',
      bgPrimary: '#121212',
      bgSecondary: '#242424',
      cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
      cardPattern: null,
      subscriptionCardText: { mode: 'light', color: null },
      cardEffect: 'aurora',
      cardEffectProps: {},
      cardEffectOpacity: 0.7,
      cardEffectsByIndex: [],
      bgEffect: 'AURORA',
      appBackground: {
        kind: 'gradient',
        effect: 'NONE',
        props: {},
        opacity: 1,
        gradient: 'linear-gradient(135deg, #121212, #242424)',
      },
      borderRadius: 'rounded-xl',
      cornerRadii: { cardPx: 12, itemPx: 8, pillPx: 9999 },
      fontFamily: 'Manrope, sans-serif',
      surfaceTheme: OPERATOR_PUBLIC_CONFIG.branding.surfaceTheme!,
    };
    const configured = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        subscriptionCardText: { mode: 'custom', color: '#1b2c3d' },
        themeVariants: {
          light: { ...baseVariant, subscriptionCardText: { mode: 'custom', color: '#1b2c3d' } },
          dark: { ...baseVariant, subscriptionCardText: { mode: 'custom', color: '#1b2c3d' } },
        },
      },
    };

    expect(isPublicConfigSnapshot(configured)).toBe(true);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          subscriptionCardText: { mode: 'custom', color: 'rgb(1, 2, 3)' },
        },
      }),
    ).toBe(false);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          subscriptionCardText: { mode: 'custom', color: '#1b2c3d80' },
        },
      }),
    ).toBe(false);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          subscriptionCardText: { mode: 'custom', color: null },
        },
      }),
    ).toBe(false);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          themeVariants: {
            ...configured.branding.themeVariants,
            dark: { ...baseVariant, subscriptionCardText: { mode: 'neon', color: null } },
          },
        },
      }),
    ).toBe(false);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          themeVariants: {
            ...configured.branding.themeVariants,
            dark: { ...baseVariant, subscriptionCardText: { mode: 'custom', color: null } },
          },
        },
      }),
    ).toBe(false);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          themeVariants: {
            ...configured.branding.themeVariants,
            dark: { ...baseVariant, subscriptionCardText: { mode: 'dark', color: null } },
          },
        },
      }),
    ).toBe(false);
  });

  it('accepts an opt-in global card-glass layer and rejects unsafe values', () => {
    const configured = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        subscriptionCardGlass: {
          enabled: true,
          tint: '#f8fafc',
          opacity: 0.16,
          blurPx: 10,
          borderOpacity: 0.24,
        },
      },
    };

    expect(isPublicConfigSnapshot(configured)).toBe(true);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          subscriptionCardGlass: {
            ...configured.branding.subscriptionCardGlass,
            tint: '#f8fafc80',
          },
        },
      }),
    ).toBe(false);
    expect(
      isPublicConfigSnapshot({
        ...configured,
        branding: {
          ...configured.branding,
          subscriptionCardGlass: {
            ...configured.branding.subscriptionCardGlass,
            blurPx: 41,
          },
        },
      }),
    ).toBe(false);
  });

  it('accepts two resolved modes for one concept and rejects a partial mode snapshot', () => {
    const baseVariant = {
      primary: '#6750a4',
      primaryFg: '#ffffff',
      bgPrimary: '#121212',
      bgSecondary: '#242424',
      cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
      cardPattern: null,
      cardEffect: 'aurora',
      cardEffectProps: {},
      cardEffectOpacity: 0.7,
      cardEffectsByIndex: [],
      bgEffect: 'AURORA',
      appBackground: {
        kind: 'gradient',
        effect: 'NONE',
        props: {},
        opacity: 1,
        gradient: 'linear-gradient(135deg, #121212, #242424)',
      },
      borderRadius: 'rounded-xl',
      cornerRadii: { cardPx: 12, itemPx: 8, pillPx: 9999 },
      fontFamily: 'Manrope, sans-serif',
      surfaceTheme: OPERATOR_PUBLIC_CONFIG.branding.surfaceTheme!,
    };
    const withModes = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        themeModePolicy: 'user-selectable',
        themeDefaultMode: 'dark',
        themeVariants: {
          light: { ...baseVariant, bgPrimary: '#f5f7ff' },
          dark: baseVariant,
        },
      },
    };

    expect(isPublicConfigSnapshot(withModes)).toBe(true);
    expect(
      isPublicConfigSnapshot({
        ...withModes,
        branding: {
          ...withModes.branding,
          themeVariants: {
            light: baseVariant,
            dark: { primary: '#ffffff' },
          },
        },
      }),
    ).toBe(false);
  });

  it('keeps legacy HTTP asset snapshots readable during the admin write migration', () => {
    const legacy = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        logoUrl: 'http://legacy-cdn.example.com/operator-logo.png',
      },
    };

    expect(isPublicConfigSnapshot(legacy)).toBe(true);
  });

  it.each([
    '/uploads/branding/.hidden.svg',
    '/uploads/branding/a..png',
    '/uploads/branding/nested/logo.png',
    '/uploads/branding/logo.png?version=2',
  ])('rejects branding upload paths the disk mirror cannot serve: %s', (logoUrl) => {
    const unsafe = {
      ...OPERATOR_PUBLIC_CONFIG,
      branding: {
        ...OPERATOR_PUBLIC_CONFIG.branding,
        logoUrl,
      },
    };

    expect(isPublicConfigSnapshot(unsafe)).toBe(false);
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
      'invalid plan card accent',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          planCardStyles: { starter: { accent: 'rgb(255, 0, 0)' } },
        },
      },
    ],
    [
      'unsafe plan card texture URL',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          planCardStyles: { starter: { textureUrl: 'javascript:alert(1)' } },
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
      'unknown navigation destination',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          navItems: [{ id: 'unknown', visible: true }],
        },
      },
    ],
    [
      'invalid semantic surface token',
      {
        ...OPERATOR_PUBLIC_CONFIG,
        branding: {
          ...OPERATOR_PUBLIC_CONFIG.branding,
          surfaceTheme: {
            ...(OPERATOR_PUBLIC_CONFIG.branding['surfaceTheme'] as Record<string, unknown>),
            glassBlurPx: 41,
          },
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

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ message: 'Configuration unavailable' });
  });
});
