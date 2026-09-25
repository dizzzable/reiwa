/**
 * The per-ENTRY fallback of the fields made of independent entries — plan card
 * styles, icon decorations, custom icons, card effect slots, navigation
 * (owner-approved 25.09.2026, CD2a §9.1).
 *
 * Taken whole, one unusable entry cost the operator every other entry of its
 * field: one stale plan card style kept all 500 previous ones. Now a refused
 * entry keeps only its own previous value — or is left out when it had none —
 * and every other entry is the operator's new one; the report names each
 * refused entry by its key.
 *
 * The guard's purpose must survive the split: no refused value may reach the
 * served body, the saved copy, the ETag behind a 304, or the browser's copy,
 * and no key may smuggle anything through it (`__proto__`, `constructor`).
 * Each of those is pinned below.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isPublicConfigSnapshot,
  splitPublicConfigKeyedField,
  PUBLIC_CONFIG_KEYED_FIELDS,
  type PublicConfigPersistencePort,
  type PublicConfigSnapshot,
} from '../../src/application/ports/public-config-persistence.port.js';
import {
  createBrandingRouter,
  getPublicConfigPayload,
  resetBrandingCache,
  resetPublicConfigDeliveryReports,
} from '../../src/api/routes/branding.js';
import { configVersionOf } from '../../src/infrastructure/config-versions/config-version.js';
import { buildPublicConfigDeliveryReport } from '../../src/infrastructure/public-config/delivery-report.js';
import { applyPublicConfigFieldFallback } from '../../src/infrastructure/public-config/field-fallback.js';

/** Every refused value below carries this, so "it reached X" is one search. */
const MARK = 'evil.example';

const STYLE = (tone: string) => ({ gradient: `linear-gradient(135deg, #111111 0%, ${tone} 100%)`, accent: tone });
const BAD_STYLE = { gradient: `url(https://${MARK}/x.png)`, accent: '#ffffff' };
const DECOR = (glyph: string) => ({ glyph, effect: 'pulse', color: '#ff00ff' });
const BAD_DECOR = { glyph: `${MARK} glyph` };
const ICON = (id: string, name: string) => ({ id, name, url: `/uploads/icons/${id}.svg`, color: null });
const BAD_ICON = (id: unknown) => ({ id, name: 1, url: `https://${MARK}/i.svg`, color: null });
const SLOT = (opacity: number) => ({ mode: 'override', cardEffect: 'aurora', cardEffectProps: {}, cardEffectOpacity: opacity });
const BAD_SLOT = { mode: 'override', cardEffect: 'aurora', cardEffectProps: {}, cardEffectOpacity: 7, cardGradient: `url(${MARK})` };

const PREVIOUS: PublicConfigSnapshot = {
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
    cardEffectsByIndex: [SLOT(0.3), SLOT(0.4)],
    bgEffect: 'NONE',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
    planCardStyles: { 'plan-1': STYLE('#aa0000'), 'plan-2': STYLE('#00aa00') },
    iconDecor: { home: DECOR('house'), gift: DECOR('box') },
    navItems: [
      { id: 'plans', visible: true },
      { id: 'faq', visible: false },
    ],
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [ICON('a', 'Old A'), ICON('b', 'Old B')],
};

function sent(branding: Record<string, unknown>, root: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...PREVIOUS,
    ...root,
    branding: { ...PREVIOUS.branding, brandName: 'Southern Lights VPN', ...branding },
  };
}

function usable(result: ReturnType<typeof applyPublicConfigFieldFallback>) {
  if (!result.usable) throw new Error(`expected a usable payload, got ${JSON.stringify(result.rejection)}`);
  return result;
}

const brandingOf = (snapshot: unknown) => (snapshot as PublicConfigSnapshot).branding as Record<string, unknown>;

describe('entry by entry: a refused entry keeps only its own previous value', () => {
  it('plan card styles: the good new ones taken, a bad one back to its own, a bad new one left out', () => {
    const result = usable(
      applyPublicConfigFieldFallback(
        sent({
          planCardStyles: {
            'plan-1': STYLE('#bb0000'),
            'plan-2': BAD_STYLE,
            'plan-3': BAD_STYLE,
            'plan-4': STYLE('#0000bb'),
          },
        }),
        PREVIOUS,
      ),
    );

    expect(brandingOf(result.snapshot)['planCardStyles']).toEqual({
      'plan-1': STYLE('#bb0000'),
      'plan-2': STYLE('#00aa00'),
      'plan-4': STYLE('#0000bb'),
    });
    expect(result.rejected.map((rejection) => [rejection.key, rejection.reason])).toEqual([
      ['branding.planCardStyles.plan-2', 'not-a-valid-plan-card-style-map'],
      ['branding.planCardStyles.plan-3', 'not-a-valid-plan-card-style-map'],
    ]);
    // The rest of the save is the operator's, as with any field.
    expect(brandingOf(result.snapshot)['brandName']).toBe('Southern Lights VPN');
    expect(isPublicConfigSnapshot(result.snapshot)).toBe(true);
  });

  it('icon decorations: the same, per icon key', () => {
    const result = usable(
      applyPublicConfigFieldFallback(
        sent({ iconDecor: { home: BAD_DECOR, gift: DECOR('star'), bell: BAD_DECOR } }),
        PREVIOUS,
      ),
    );
    expect(brandingOf(result.snapshot)['iconDecor']).toEqual({ home: DECOR('house'), gift: DECOR('star') });
    expect(result.rejected.map((rejection) => rejection.key)).toEqual([
      'branding.iconDecor.home',
      'branding.iconDecor.bell',
    ]);
  });

  it('custom icons: a bad icon back to the served icon of the same id, in its place; one with no id left out', () => {
    const result = usable(
      applyPublicConfigFieldFallback(
        sent({}, { customIcons: [ICON('a', 'New A'), BAD_ICON('b'), BAD_ICON(5), ICON('c', 'New C')] }),
        PREVIOUS,
      ),
    );
    expect(result.snapshot['customIcons']).toEqual([ICON('a', 'New A'), ICON('b', 'Old B'), ICON('c', 'New C')]);
    expect(result.rejected.map((rejection) => [rejection.key, rejection.reason])).toEqual([
      ['customIcons[1]', 'not-a-valid-custom-icon'],
      ['customIcons[2]', 'not-a-valid-custom-icon'],
    ]);
  });

  it('card effect slots: a bad slot back to the served slot of the same card; with none, «inherit» — the cards after it do not move', () => {
    const result = usable(
      applyPublicConfigFieldFallback(
        sent({ cardEffectsByIndex: [SLOT(0.9), BAD_SLOT, BAD_SLOT, SLOT(0.6)] }),
        PREVIOUS,
      ),
    );
    expect(brandingOf(result.snapshot)['cardEffectsByIndex']).toEqual([
      SLOT(0.9),
      SLOT(0.4),
      { mode: 'inherit' },
      SLOT(0.6),
    ]);
    expect(result.rejected.map((rejection) => rejection.key)).toEqual([
      'branding.cardEffectsByIndex[1]',
      'branding.cardEffectsByIndex[2]',
    ]);
  });

  it('navigation: a bad entry back to the served entry of its destination; an unknown one and a repeated one left out', () => {
    const result = usable(
      applyPublicConfigFieldFallback(
        sent({
          navItems: [
            { id: 'faq', visible: 'yes' },
            { id: 'nowhere', visible: true },
            { id: 'plans', visible: true },
            { id: 'plans', visible: false },
            { id: 'support', visible: true },
          ],
        }),
        PREVIOUS,
      ),
    );
    expect(brandingOf(result.snapshot)['navItems']).toEqual([
      { id: 'faq', visible: false },
      { id: 'plans', visible: true },
      { id: 'support', visible: true },
    ]);
    expect(result.rejected.map((rejection) => [rejection.key, rejection.reason])).toEqual([
      ['branding.navItems[0]', 'not-a-valid-nav-item'],
      ['branding.navItems[1]', 'not-a-valid-nav-item'],
      ['branding.navItems[3]', 'duplicate-destination-id'],
    ]);
  });

  it('with nothing served yet, a refused entry is left out and the rest is taken', () => {
    const result = usable(
      applyPublicConfigFieldFallback(sent({}, { customIcons: [BAD_ICON('b'), ICON('c', 'New C')] }), null),
    );
    expect(result.snapshot['customIcons']).toEqual([ICON('c', 'New C')]);
  });

  it('a field that cannot be taken apart still falls back whole: the wrong kind of collection, or too many entries', () => {
    const notAMap = usable(applyPublicConfigFieldFallback(sent({ planCardStyles: ['nope'] }), PREVIOUS));
    expect(brandingOf(notAMap.snapshot)['planCardStyles']).toEqual(PREVIOUS.branding['planCardStyles']);
    expect(notAMap.rejected.map((rejection) => rejection.key)).toEqual(['branding.planCardStyles']);

    const tooMany = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`p-${index}`, STYLE('#123456')]));
    const crowded = usable(applyPublicConfigFieldFallback(sent({ planCardStyles: tooMany }), PREVIOUS));
    expect(brandingOf(crowded.snapshot)['planCardStyles']).toEqual(PREVIOUS.branding['planCardStyles']);

    const slots = usable(applyPublicConfigFieldFallback(sent({ cardEffectsByIndex: Array(21).fill(SLOT(0.5)) }), PREVIOUS));
    expect(brandingOf(slots.snapshot)['cardEffectsByIndex']).toEqual(PREVIOUS.branding['cardEffectsByIndex']);
  });

  it('covers the five keyed fields, and no other', () => {
    expect([...PUBLIC_CONFIG_KEYED_FIELDS].sort()).toEqual([
      'branding.cardEffectsByIndex',
      'branding.iconDecor',
      'branding.navItems',
      'branding.planCardStyles',
      'customIcons',
    ]);
    expect(splitPublicConfigKeyedField('branding.primary', '#fff', '#000')).toBeNull();
  });
});

describe('the report names each refused entry', () => {
  it('by its key, with the value the panel sent there — a plan id with a dot in it included', () => {
    const incoming = sent({ planCardStyles: { 'plan.v2[beta]': BAD_STYLE, 'plan-1': STYLE('#bb0000') } });
    const result = usable(applyPublicConfigFieldFallback(incoming, PREVIOUS));
    const report = buildPublicConfigDeliveryReport('v1', incoming, result.rejected);
    expect(report.rejected).toEqual([
      {
        path: 'branding.planCardStyles.plan.v2[beta]',
        reason: 'not-a-valid-plan-card-style-map',
        value: JSON.stringify(BAD_STYLE),
      },
    ]);
  });
});

describe('no key smuggles anything through the split', () => {
  it('`__proto__` stays an own entry — never the prototype — and `constructor`/`toString` never find a prototype value', () => {
    // As the transport reads it: JSON.parse makes `__proto__` an own key.
    const styles = JSON.parse(
      JSON.stringify({ toString: STYLE('#abcdef'), constructor: BAD_STYLE }).replace('"toString"', '"__proto__"'),
    ) as Record<string, unknown>;
    styles['toString'] = BAD_STYLE;
    expect(Object.hasOwn(styles, '__proto__')).toBe(true);

    const result = usable(applyPublicConfigFieldFallback(sent({ planCardStyles: styles }), PREVIOUS));
    const served = brandingOf(result.snapshot)['planCardStyles'] as Record<string, unknown>;

    expect(Object.getPrototypeOf(served)).toBe(Object.prototype);
    expect(Object.hasOwn(served, '__proto__')).toBe(true);
    expect(Object.hasOwn(served, 'constructor')).toBe(false);
    expect(Object.hasOwn(served, 'toString')).toBe(false);
    expect(Object.keys(served)).toEqual(['__proto__']);
    expect(JSON.stringify(result.snapshot)).not.toContain(MARK);
    expect(isPublicConfigSnapshot(result.snapshot)).toBe(true);
  });
});

function memoryPersistence(initial: { snapshot: PublicConfigSnapshot; version: string }) {
  let kept = initial;
  return {
    load: vi.fn(async () => kept.snapshot),
    loadServed: vi.fn(async () => kept),
    save: vi.fn(async (snapshot: PublicConfigSnapshot, version?: string) => {
      kept = { snapshot, version: version ?? configVersionOf(snapshot) };
    }),
  } satisfies PublicConfigPersistencePort;
}

/** Everything bad at once, in every keyed field. */
const EVERYTHING_BAD = sent(
  {
    planCardStyles: { 'plan-1': STYLE('#bb0000'), 'plan-2': BAD_STYLE },
    iconDecor: { home: BAD_DECOR },
    cardEffectsByIndex: [BAD_SLOT],
    navItems: [{ id: 'plans', visible: true }, { id: MARK, visible: true }],
  },
  { customIcons: [BAD_ICON('b')] },
);

describe('what reaches every place a served copy goes', () => {
  beforeEach(() => {
    resetBrandingCache();
    resetPublicConfigDeliveryReports();
  });
  afterEach(() => {
    resetBrandingCache();
    resetPublicConfigDeliveryReports();
  });

  it('the served body and the saved copy: every good new entry, no refused value', async () => {
    const persistence = memoryPersistence({ snapshot: PREVIOUS, version: 'p' });
    const client = { branding: { getReiwaPublicConfig: vi.fn(async () => EVERYTHING_BAD) } } as never;

    const payload = await getPublicConfigPayload(client, undefined, persistence);

    expect(JSON.stringify(payload.body)).not.toContain(MARK);
    expect(brandingOf(payload.body)['planCardStyles']).toEqual({
      'plan-1': STYLE('#bb0000'),
      'plan-2': STYLE('#00aa00'),
    });
    expect(isPublicConfigSnapshot(payload.body)).toBe(true);
    const [savedSnapshot, savedVersion] = persistence.save.mock.calls[0] ?? [];
    expect(savedSnapshot).toEqual(payload.body);
    expect(JSON.stringify(savedSnapshot)).not.toContain(MARK);
    expect(savedVersion).toBe(configVersionOf(EVERYTHING_BAD));
  });

  it('the 304: the ETag is the served body’s — the raw payload’s would not match', async () => {
    const app = express();
    app.use(
      '/api/v1',
      createBrandingRouter({
        adminClient: { branding: { getReiwaPublicConfig: async () => EVERYTHING_BAD } } as never,
        publicConfigPersistence: memoryPersistence({ snapshot: PREVIOUS, version: 'p' }),
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/public-config`;
      const first = await fetch(url);
      const body = (await first.json()) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain(MARK);
      const etag = first.headers.get('etag') ?? '';
      const weak = (value: unknown) => `W/"${createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16)}"`;
      expect(etag).not.toBe(weak(EVERYTHING_BAD));

      expect((await fetch(url, { headers: { 'if-none-match': etag } })).status).toBe(304);
      // A client holding the raw payload's tag gets the served body, not a 304.
      expect((await fetch(url, { headers: { 'if-none-match': weak(EVERYTHING_BAD) } })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  // The browser's copy: `test/web/public-config-entry-fallback-browser.test.ts`
  // (it imports `web/src`, which only the web test project compiles).
});
