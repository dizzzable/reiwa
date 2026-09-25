import { afterEach, describe, expect, it } from 'vitest';

import { isPublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import { applyPublicConfigFieldFallback } from '../../src/infrastructure/public-config/field-fallback.js';
import { readPublicConfigSnapshot, writePublicConfigSnapshot } from '../../web/src/lib/public-config-snapshot.js';

/**
 * The browser's copy of the public config under the per-ENTRY fallback
 * (CD2a §9.1): the SPA keeps what it was served in localStorage for its next
 * first paint (`web/src/lib/public-config-snapshot.ts`), guarded by the same
 * guard as the server. What the cabinet serves after refusing entries passes
 * that guard whole and is stored; the payload with the refused entries in it
 * is never stored. The server-side paths — the body, the saved copy, the 304 —
 * are in `test/api/public-config-entry-fallback.test.ts`.
 */

const MARK = 'evil.example';
const STYLE = (tone: string) => ({ gradient: `linear-gradient(135deg, #111111 0%, ${tone} 100%)`, accent: tone });

const PREVIOUS = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: null,
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
    cardLogo: 'DEFAULT',
    cardLogoUrl: null,
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 0.7,
    cardEffectsByIndex: [],
    bgEffect: 'NONE',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
    planCardStyles: { 'plan-1': STYLE('#aa0000'), 'plan-2': STYLE('#00aa00') },
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
};

const INCOMING = {
  ...PREVIOUS,
  branding: {
    ...PREVIOUS.branding,
    brandName: 'Southern Lights VPN',
    planCardStyles: { 'plan-1': STYLE('#bb0000'), 'plan-2': { gradient: `url(https://${MARK}/x.png)` } },
  },
  customIcons: [{ id: 'b', name: 1, url: `https://${MARK}/i.svg`, color: null }],
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('the browser’s copy under the per-entry fallback', () => {
  it('stores the served body — which passes the guard whole — and never the payload with the refused entries', () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => void values.set(key, value),
        },
      },
    });
    const result = applyPublicConfigFieldFallback(INCOMING, PREVIOUS);
    if (!result.usable) throw new Error('expected a usable payload');
    // Anchor: entries were refused, so this is the split's output (in the
    // guard's order, which checks the icons before the plan styles).
    expect(result.rejected.map((rejection) => rejection.key)).toEqual([
      'customIcons[0]',
      'branding.planCardStyles.plan-2',
    ]);

    writePublicConfigSnapshot(INCOMING as never);
    expect(values.size).toBe(0);

    writePublicConfigSnapshot(result.snapshot as never);
    expect(isPublicConfigSnapshot(result.snapshot)).toBe(true);
    expect(readPublicConfigSnapshot()).toEqual(result.snapshot);
    expect([...values.values()].join('')).not.toContain(MARK);
    expect((readPublicConfigSnapshot()?.branding as unknown as Record<string, unknown>)['planCardStyles']).toEqual({
      'plan-1': STYLE('#bb0000'),
      'plan-2': STYLE('#00aa00'),
    });
  });
});
