/**
 * The server's copy of the cabinet's built-in appearance.
 *
 * When the per-field fallback has nothing served to fall back to — a first
 * start whose very first panel answer carries a bad field — a required field
 * takes the value the cabinet paints when the panel sends nothing at all. The
 * SPA owns those values (`DEFAULT_PUBLIC_CONFIG` in `web/src/types/branding.ts`)
 * and the server build cannot import them, so it keeps a copy
 * (`src/infrastructure/public-config/field-fallback.ts`). A copy drifts in
 * silence; this holds the two equal, key by key.
 */
import { describe, expect, it } from 'vitest';

import { isPublicConfigSnapshot } from '../../src/application/ports/public-config-persistence.port.js';
import { PUBLIC_CONFIG_BUILT_IN_DEFAULTS } from '../../src/infrastructure/public-config/field-fallback.js';
import { DEFAULT_PUBLIC_CONFIG } from '../../web/src/types/branding.js';

describe('the built-in values the server falls back to', () => {
  const spaRoot = DEFAULT_PUBLIC_CONFIG as unknown as Record<string, unknown>;
  const spaBranding = DEFAULT_PUBLIC_CONFIG.branding as unknown as Record<string, unknown>;

  it.each(Object.entries(PUBLIC_CONFIG_BUILT_IN_DEFAULTS.branding))(
    'branding.%s is what the SPA paints',
    (key, value) => {
      expect(Object.hasOwn(spaBranding, key)).toBe(true);
      expect(value).toEqual(spaBranding[key]);
    },
  );

  it.each(Object.entries(PUBLIC_CONFIG_BUILT_IN_DEFAULTS.root))('%s is what the SPA uses', (key, value) => {
    expect(Object.hasOwn(spaRoot, key)).toBe(true);
    expect(value).toEqual(spaRoot[key]);
  });

  it('are enough on their own: a payload of nothing else passes the guard whole', () => {
    // Every required field has a built-in value, so a fallback with nothing
    // served can always produce a payload the cabinet may serve.
    expect(
      isPublicConfigSnapshot({
        ...PUBLIC_CONFIG_BUILT_IN_DEFAULTS.root,
        branding: { ...PUBLIC_CONFIG_BUILT_IN_DEFAULTS.branding },
      }),
    ).toBe(true);
  });
});
