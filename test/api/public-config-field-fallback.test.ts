/**
 * «Неверное значение оформления: всё новое применяется, кроме него» — the
 * owner's rule of 24.09.2026 (W8 report D9).
 *
 * A fresh panel payload used to be refused WHOLE for one bad key: the cabinet
 * went on serving the previous appearance — every colour, logo and text — for
 * as long as the key survived, while the panel reported the save as done. Now
 * each part is judged alone and only the parts that fail keep the value the
 * cabinet served last (else its built-in value). These specs pin:
 *
 *   - the per-field verdict accepts exactly what the whole guard accepts, and
 *     names every failing part, not only the first;
 *   - what is served: every good new value, the previous value for each bad
 *     one, "absent" where the previous snapshot had none, the built-in value
 *     when nothing was ever served, and a result that passes the guard whole;
 *   - the two pairs the guard can only judge together fall back together;
 *   - the version the process reports as held stays the PANEL's version even
 *     when a field fell back — the panel's delivery check and the SPA's
 *     watcher both compare against it;
 *   - the saved copy is the merged payload under the panel's version, and a
 *     restart reports that version;
 *   - the report to the panel: once per version per process, with the path,
 *     the reason and the rejected value cut to 120 characters.
 */
import http from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assessPublicConfigFields,
  describePublicConfigSnapshot,
  isPublicConfigSnapshot,
  type PublicConfigPersistencePort,
  type PublicConfigSnapshot,
} from '../../src/application/ports/public-config-persistence.port.js';
import {
  createBrandingRouter,
  getPublicConfigPayload,
  heldPublicConfigVersion,
  resetBrandingCache,
  resetPublicConfigDeliveryReports,
} from '../../src/api/routes/branding.js';
import { configVersionOf } from '../../src/infrastructure/config-versions/config-version.js';
import { RedisLastKnownGoodStore } from '../../src/infrastructure/config-versions/last-known-good.js';
import {
  buildPublicConfigDeliveryReport,
  MAX_REPORTED_VALUE_LENGTH,
  PublicConfigDeliveryReporter,
} from '../../src/infrastructure/public-config/delivery-report.js';
import {
  applyPublicConfigFieldFallback,
  PUBLIC_CONFIG_BUILT_IN_DEFAULTS,
} from '../../src/infrastructure/public-config/field-fallback.js';
import { RedisPublicConfigPersistence } from '../../src/infrastructure/public-config/redis-public-config-persistence.js';
import { createPublicConfigRejectionNotifier } from '../../src/infrastructure/public-config/rejection-notifier.js';

const SURFACE_THEME = {
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
};

/** What the cabinet served before the save. */
const PREVIOUS: PublicConfigSnapshot = {
  branding: {
    brandName: 'Northern Lights VPN',
    logoUrl: '/uploads/branding/northern-lights.svg',
    primary: '#6750a4',
    primaryFg: '#ffffff',
    bgPrimary: '#121212',
    bgSecondary: '#242424',
    cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
    cardPattern: null,
    cardLogo: 'CUSTOM',
    cardLogoUrl: null,
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 0.7,
    cardEffectsByIndex: [],
    bgEffect: 'AURORA',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-xl',
    fontFamily: 'Manrope, sans-serif',
    tagline: 'Private by default',
    navGap: 6,
    surfaceTheme: SURFACE_THEME,
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
};

/** The operator's save: every value differs from `PREVIOUS`, all of them valid. */
const SAVED: PublicConfigSnapshot = {
  branding: {
    ...PREVIOUS.branding,
    brandName: 'Southern Lights VPN',
    primary: '#b3261e',
    borderRadius: 'rounded-3xl',
    fontFamily: 'Inter, sans-serif',
    tagline: 'Fast and private',
    navGap: 10,
    // Not judged by the guard — always taken as sent.
    brandLogo: { size: 1.2, fill: 0.7, frame: 'glass', radius: null, glow: 0.4 },
  },
  locales: ['en', 'ru', 'de'],
  defaultLocale: 'de',
  defaultCurrency: 'USD',
  customIcons: [],
  somethingThePanelAddedLater: { a: 1 },
};

function saved(brandingOverrides: Record<string, unknown>, rootOverrides: Record<string, unknown> = {}): unknown {
  return { ...SAVED, ...rootOverrides, branding: { ...SAVED.branding, ...brandingOverrides } };
}

function brandingOf(snapshot: unknown): Record<string, unknown> {
  return (snapshot as PublicConfigSnapshot).branding as Record<string, unknown>;
}

describe('the per-field verdict', () => {
  const SAMPLES: readonly [string, unknown][] = [
    ['a clean payload', SAVED],
    ['one bad colour', saved({ primary: 'rebeccapurple' })],
    ['a bad colour and a bad radius', saved({ primary: 'rebeccapurple', borderRadius: 'rounded-md' })],
    ['a default locale outside the list', saved({}, { defaultLocale: 'fr' })],
    ['an unknown nav destination', saved({ navItems: [{ id: 'nowhere', visible: true }] })],
    ['a bad custom icon', saved({}, { customIcons: [{ id: 1 }] })],
    ['no branding object', { ...SAVED, branding: null }],
    ['not an object', 'nope'],
  ];

  it.each(SAMPLES)('agrees with the whole guard on %s', (_label, candidate) => {
    const whole = describePublicConfigSnapshot(candidate);
    const assessed = assessPublicConfigFields(candidate);
    const first = assessed.shape ?? assessed.rejected[0] ?? null;
    expect(first === null ? null : { key: first.key, reason: first.reason, found: first.found }).toEqual(whole);
  });

  it('names EVERY failing part, in the guard’s order — not only the first', () => {
    const assessed = assessPublicConfigFields(
      saved({ primary: 'rebeccapurple', borderRadius: 'rounded-md' }, { defaultCurrency: 42 }),
    );
    expect(assessed.shape).toBeNull();
    expect(assessed.rejected.map((rejection) => [rejection.key, rejection.fields])).toEqual([
      ['branding.primary', ['branding.primary']],
      ['branding.borderRadius', ['branding.borderRadius']],
      ['defaultCurrency', ['defaultCurrency']],
    ]);
  });

  it('judges a payload with no branding object as unusable as a whole', () => {
    const assessed = assessPublicConfigFields({ ...SAVED, branding: [] });
    expect(assessed.shape).toEqual({ key: 'branding', reason: 'not-an-object', found: 'array(length=0)' });
    expect(assessed.rejected).toEqual([]);
  });
});

describe('what is served when parts are rejected', () => {
  it('takes every good new value and keeps the previous value of the bad one', () => {
    const result = applyPublicConfigFieldFallback(saved({ borderRadius: 'rounded-md' }), PREVIOUS);
    if (!result.usable) throw new Error('expected a usable payload');

    const branding = brandingOf(result.snapshot);
    expect(branding['borderRadius']).toBe('rounded-xl');
    // Everything else is the operator's save, fields the guard does not
    // judge and fields it has never heard of included.
    expect(branding['brandName']).toBe('Southern Lights VPN');
    expect(branding['primary']).toBe('#b3261e');
    expect(branding['fontFamily']).toBe('Inter, sans-serif');
    expect(branding['brandLogo']).toEqual(SAVED.branding['brandLogo']);
    expect(result.snapshot['somethingThePanelAddedLater']).toEqual({ a: 1 });
    expect(result.snapshot.locales).toEqual(['en', 'ru', 'de']);
    expect(result.rejected.map((rejection) => rejection.key)).toEqual(['branding.borderRadius']);
    expect(isPublicConfigSnapshot(result.snapshot)).toBe(true);
  });

  it('keeps the previous value of each bad field, reporting all of them', () => {
    const result = applyPublicConfigFieldFallback(
      saved({ primary: 'rebeccapurple', borderRadius: 'rounded-md' }, { defaultCurrency: 42 }),
      PREVIOUS,
    );
    if (!result.usable) throw new Error('expected a usable payload');
    expect(brandingOf(result.snapshot)['primary']).toBe('#6750a4');
    expect(brandingOf(result.snapshot)['borderRadius']).toBe('rounded-xl');
    expect(result.snapshot['defaultCurrency']).toBe('EUR');
    expect(brandingOf(result.snapshot)['brandName']).toBe('Southern Lights VPN');
    expect(result.rejected.map((rejection) => rejection.key)).toEqual([
      'branding.primary',
      'branding.borderRadius',
      'defaultCurrency',
    ]);
  });

  it('leaves out an optional field the previous snapshot did not carry', () => {
    const { navGap: _navGap, ...withoutNavGap } = PREVIOUS.branding;
    const result = applyPublicConfigFieldFallback(saved({ navGap: 99 }), {
      ...PREVIOUS,
      branding: withoutNavGap,
    });
    if (!result.usable) throw new Error('expected a usable payload');
    // "Absent" is what the cabinet served, so absent it stays.
    expect(Object.hasOwn(brandingOf(result.snapshot), 'navGap')).toBe(false);
    expect(brandingOf(result.snapshot)['brandName']).toBe('Southern Lights VPN');
  });

  it('with nothing served yet, uses the built-in value of a required field and drops an optional one', () => {
    const result = applyPublicConfigFieldFallback(saved({ primary: 'rebeccapurple', tagline: 42 }), null);
    if (!result.usable) throw new Error('expected a usable payload');
    expect(brandingOf(result.snapshot)['primary']).toBe(PUBLIC_CONFIG_BUILT_IN_DEFAULTS.branding['primary']);
    expect(brandingOf(result.snapshot)['primary']).toBe('#22c55e');
    expect(Object.hasOwn(brandingOf(result.snapshot), 'tagline')).toBe(false);
    expect(brandingOf(result.snapshot)['brandName']).toBe('Southern Lights VPN');
    expect(isPublicConfigSnapshot(result.snapshot)).toBe(true);
  });

  it('never hands out the built-in constants themselves', () => {
    const result = applyPublicConfigFieldFallback(saved({ iconColors: { accent: 'nope' } }), null);
    if (!result.usable) throw new Error('expected a usable payload');
    (brandingOf(result.snapshot)['iconColors'] as Record<string, string>)['accent'] = '#000000';
    expect(PUBLIC_CONFIG_BUILT_IN_DEFAULTS.branding['iconColors']).toEqual({});
  });

  it('takes `locales` and `defaultLocale` back together: the default must be one of the list', () => {
    const result = applyPublicConfigFieldFallback(saved({}, { defaultLocale: 'fr' }), PREVIOUS);
    if (!result.usable) throw new Error('expected a usable payload');
    expect(result.snapshot.locales).toEqual(['en', 'ru']);
    expect(result.snapshot.defaultLocale).toBe('en');
    expect(result.rejected.map((rejection) => [rejection.key, rejection.reason])).toEqual([
      ['defaultLocale', 'not-listed-in-locales'],
    ]);
  });

  it('widens to the other half of a pair when a value taken back no longer matches it', () => {
    const variant = (textMode: 'light' | 'dark') => ({
      primary: '#6750a4',
      primaryFg: '#ffffff',
      bgPrimary: '#121212',
      bgSecondary: '#242424',
      cardGradient: 'linear-gradient(135deg, #312e81 0%, #a78bfa 100%)',
      cardPattern: null,
      subscriptionCardText: { mode: textMode, color: null },
      cardEffect: 'aurora',
      cardEffectProps: {},
      cardEffectOpacity: 0.7,
      cardEffectsByIndex: [],
      bgEffect: 'AURORA',
      appBackground: { kind: 'none', effect: 'NONE', props: {}, opacity: 1, gradient: 'linear-gradient(#111, #222)' },
      borderRadius: 'rounded-xl',
      cornerRadii: { cardPx: 12, itemPx: 8, pillPx: 9999 },
      fontFamily: 'Manrope, sans-serif',
      surfaceTheme: SURFACE_THEME,
    });
    const previous: PublicConfigSnapshot = {
      ...PREVIOUS,
      branding: {
        ...PREVIOUS.branding,
        subscriptionCardText: { mode: 'light', color: null },
        themeVariants: { light: variant('light'), dark: variant('light') },
      },
    };
    expect(isPublicConfigSnapshot(previous)).toBe(true);

    // The new root text is fine on its own; the new variants are not (one has
    // no primary colour). Taking the variants back brings the OLD text policy
    // with them, which the new root no longer matches — so the root text has
    // to be taken back too, and that is reported.
    const brokenDark = { ...variant('dark'), primary: undefined };
    const result = applyPublicConfigFieldFallback(
      saved({
        subscriptionCardText: { mode: 'dark', color: null },
        themeVariants: { light: variant('dark'), dark: brokenDark },
      }),
      previous,
    );
    if (!result.usable) throw new Error('expected a usable payload');
    expect(brandingOf(result.snapshot)['subscriptionCardText']).toEqual({ mode: 'light', color: null });
    expect(brandingOf(result.snapshot)['themeVariants']).toEqual(previous.branding['themeVariants']);
    expect(brandingOf(result.snapshot)['brandName']).toBe('Southern Lights VPN');
    expect(result.rejected.map((rejection) => rejection.key)).toEqual([
      'branding.themeVariants',
      'branding.themeVariants.subscriptionCardText',
    ]);
    expect(isPublicConfigSnapshot(result.snapshot)).toBe(true);
  });

  it('still refuses a payload unusable as a whole', () => {
    const result = applyPublicConfigFieldFallback({ ...SAVED, branding: 'x' }, PREVIOUS);
    expect(result).toEqual({
      usable: false,
      rejection: { key: 'branding', reason: 'not-an-object', found: 'string "x"' },
    });
  });

  it('does not touch the previous snapshot', () => {
    const before = JSON.stringify(PREVIOUS);
    applyPublicConfigFieldFallback(saved({ borderRadius: 'rounded-md', primary: 'x' }), PREVIOUS);
    expect(JSON.stringify(PREVIOUS)).toBe(before);
  });
});

function memoryPersistence(initial: { snapshot: PublicConfigSnapshot; version: string } | null = null) {
  let kept = initial;
  return {
    load: vi.fn(async () => kept?.snapshot ?? null),
    loadServed: vi.fn(async () => kept),
    save: vi.fn(async (snapshot: PublicConfigSnapshot, version?: string) => {
      kept = { snapshot, version: version ?? configVersionOf(snapshot) };
    }),
  } satisfies PublicConfigPersistencePort;
}

function adminClientAnswering(answer: () => unknown, report = vi.fn(async () => ({ ok: true }))) {
  return {
    client: {
      branding: {
        getReiwaPublicConfig: vi.fn(async () => answer()),
        reportPublicConfigDelivery: report,
      },
    } as never,
    report,
  };
}

describe('the route with a partly rejected payload', () => {
  beforeEach(() => {
    resetBrandingCache();
    resetPublicConfigDeliveryReports();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetBrandingCache();
    resetPublicConfigDeliveryReports();
  });

  it('holds the PANEL’s version, and saves the merged payload under it', async () => {
    const sent = saved({ borderRadius: 'rounded-md' });
    const persistence = memoryPersistence({ snapshot: PREVIOUS, version: configVersionOf(PREVIOUS) });
    const { client } = adminClientAnswering(() => sent);

    const payload = await getPublicConfigPayload(client, undefined, persistence);

    expect(brandingOf(payload.body)['borderRadius']).toBe('rounded-xl');
    expect(brandingOf(payload.body)['brandName']).toBe('Southern Lights VPN');
    // Not the merged body's own hash — what the panel sent.
    expect(configVersionOf(payload.body)).not.toBe(configVersionOf(sent));
    expect(payload.version).toBe(configVersionOf(sent));
    expect(heldPublicConfigVersion()).toBe(configVersionOf(sent));
    expect(persistence.save).toHaveBeenCalledWith(payload.body, configVersionOf(sent));
  });

  it('after a reset, takes the previous value from the saved copy', async () => {
    const persistence = memoryPersistence({ snapshot: PREVIOUS, version: 'v-previous' });
    const { client } = adminClientAnswering(() => saved({ primary: 'rebeccapurple' }));

    const payload = await getPublicConfigPayload(client, undefined, persistence);

    expect(persistence.load).toHaveBeenCalled();
    expect(brandingOf(payload.body)['primary']).toBe('#6750a4');
  });

  it('prefers the snapshot it is serving over the saved copy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    // The saved copy disagrees with what is being served (and keeps
    // disagreeing: this one ignores saves); "served last" is what customers
    // are looking at now.
    const stale = { ...PREVIOUS, branding: { ...PREVIOUS.branding, primary: '#000000' } };
    const persistence = {
      load: vi.fn(async () => stale),
      save: vi.fn(async () => undefined),
    } satisfies PublicConfigPersistencePort;
    let answer: unknown = PREVIOUS;
    const { client } = adminClientAnswering(() => answer);
    await getPublicConfigPayload(client, undefined, persistence);
    expect(brandingOf((await getPublicConfigPayload(client, undefined, persistence)).body)['primary']).toBe('#6750a4');

    // Past the TTL: the stale copy is served while one refresh runs.
    answer = saved({ primary: 'rebeccapurple' });
    vi.setSystemTime(new Date('2026-09-24T12:02:00Z'));
    await getPublicConfigPayload(client, undefined, persistence);
    await vi.waitFor(() => expect(heldPublicConfigVersion()).toBe(configVersionOf(answer)));

    const refreshed = await getPublicConfigPayload(client, undefined, persistence);
    expect(brandingOf(refreshed.body)['primary']).toBe('#6750a4');
    expect(brandingOf(refreshed.body)['brandName']).toBe('Southern Lights VPN');
  });

  it('after a restart, reports the version the copy was saved under', async () => {
    const persistence = memoryPersistence({ snapshot: PREVIOUS, version: 'a'.repeat(32) });
    const { client } = adminClientAnswering(() => {
      throw new Error('panel down');
    });

    const payload = await getPublicConfigPayload(client, undefined, persistence);

    expect(payload.body).toBe(PREVIOUS);
    expect(heldPublicConfigVersion()).toBe('a'.repeat(32));
  });

  it('reports what it did not take once per version, and a clean version once too', async () => {
    let answer: unknown = saved({ borderRadius: 'rounded-md' });
    const { client, report } = adminClientAnswering(() => answer);
    const persistence = memoryPersistence({ snapshot: PREVIOUS, version: 'p' });

    await getPublicConfigPayload(client, undefined, persistence);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith({
      version: configVersionOf(answer),
      rejected: [{ path: 'branding.borderRadius', reason: 'not-an-allowed-value', value: '"rounded-md"' }],
    });

    // The same version read again — a TTL, a hint — is not reported again.
    resetBrandingCache();
    await getPublicConfigPayload(client, undefined, persistence);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(report).toHaveBeenCalledTimes(1);

    // The operator fixes it: a new version, taken whole, is reported as such.
    answer = SAVED;
    resetBrandingCache();
    await getPublicConfigPayload(client, undefined, persistence);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report).toHaveBeenLastCalledWith({ version: configVersionOf(SAVED), rejected: [] });
  });

  it('names the fields in the system event, once, with the previous value kept', async () => {
    const warnings: Array<{ ctx: Record<string, unknown>; message: string }> = [];
    const logger = {
      warn: (ctx: unknown, message?: unknown) => warnings.push({ ctx: ctx as Record<string, unknown>, message: String(message) }),
      info: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
      trace: () => undefined,
      child: () => logger,
    };
    const reports: Array<{ message: string }> = [];
    const notifier = createPublicConfigRejectionNotifier({
      logger: logger as never,
      errorReporter: { report: (input) => void reports.push(input) },
      now: () => 0,
    });
    const { client } = adminClientAnswering(() => saved({ primary: 'x', borderRadius: 'rounded-md' }));
    const persistence = memoryPersistence({ snapshot: PREVIOUS, version: 'p' });

    await getPublicConfigPayload(client, undefined, persistence, notifier);
    resetBrandingCache();
    await getPublicConfigPayload(client, undefined, persistence, notifier);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('"branding.primary"');
    expect(reports[0]?.message).toContain('"branding.borderRadius"');
    expect(reports[0]?.message).toContain('applied without 2 fields');
    expect(warnings[0]?.ctx['fields']).toEqual([
      { key: 'branding.primary', reason: 'not-a-hex-colour', found: 'string "x"' },
      { key: 'branding.borderRadius', reason: 'not-an-allowed-value', found: 'string "rounded-md"' },
    ]);
  });
});

describe('the public-config route', () => {
  beforeEach(() => resetBrandingCache());
  afterEach(() => resetBrandingCache());

  it('names the panel version of the body it serves, on a 304 too', async () => {
    const sent = saved({ borderRadius: 'rounded-md' });
    const app = express();
    app.use(
      '/api/v1',
      createBrandingRouter({
        adminClient: { branding: { getReiwaPublicConfig: async () => sent } } as never,
        publicConfigPersistence: memoryPersistence({ snapshot: PREVIOUS, version: 'p' }),
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const first = await fetch(`http://127.0.0.1:${port}/api/v1/public-config`);
      expect(first.status).toBe(200);
      expect(first.headers.get('x-config-version')).toBe(configVersionOf(sent));

      const again = await fetch(`http://127.0.0.1:${port}/api/v1/public-config`, {
        headers: { 'if-none-match': first.headers.get('etag') ?? '' },
      });
      expect(again.status).toBe(304);
      expect(again.headers.get('x-config-version')).toBe(configVersionOf(sent));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the report to the panel', () => {
  it('points at the value itself — an array entry, or the first field of a pair', () => {
    const incoming = saved({
      navItems: [{ id: 'plans', visible: true }, { id: 'nowhere', visible: true }],
      themeVariants: { light: 'x' },
    });
    const report = buildPublicConfigDeliveryReport('v1', incoming, [
      { key: 'branding.navItems[1]', reason: 'not-a-valid-nav-item', found: 'object(keys=2)', fields: ['branding.navItems'] },
      {
        key: 'branding.themeVariants.subscriptionCardText',
        reason: 'does-not-match-the-root-card-text-policy',
        found: 'absent',
        fields: ['branding.themeVariants', 'branding.subscriptionCardText'],
      },
    ]);
    expect(report).toEqual({
      version: 'v1',
      rejected: [
        { path: 'branding.navItems[1]', reason: 'not-a-valid-nav-item', value: '{"id":"nowhere","visible":true}' },
        { path: 'branding.themeVariants.subscriptionCardText', reason: 'does-not-match-the-root-card-text-policy', value: '{"light":"x"}' },
      ],
    });
    // A key the panel did not send at all reads as such.
    expect(
      buildPublicConfigDeliveryReport('v1', saved({}), [
        { key: 'branding.navItems', reason: 'not-an-array', found: 'absent', fields: ['branding.navItems'] },
      ]).rejected[0]?.value,
    ).toBe('(absent)');
  });

  it('cuts the value to the limit', () => {
    const logo = `data:image/png;base64,${'A'.repeat(4096)}`;
    const report = buildPublicConfigDeliveryReport('v1', saved({ logoUrl: logo }), [
      { key: 'branding.logoUrl', reason: 'not-an-allowed-image-url', found: 'string(length=4118)', fields: ['branding.logoUrl'] },
    ]);
    const value = report.rejected[0]?.value ?? '';
    expect(MAX_REPORTED_VALUE_LENGTH).toBe(120);
    expect(value.length).toBe(120);
    expect(value.startsWith('"data:image/png;base64,AAAA')).toBe(true);
    expect(value.endsWith('…')).toBe(true);
  });

  it('is sent once per version; a failed send is tried again, a 404 is not', async () => {
    const reporter = new PublicConfigDeliveryReporter();
    const failing = vi.fn(async () => {
      throw new Error('panel down');
    });
    reporter.offer({ version: 'v1', rejected: [] }, failing);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ok = vi.fn(async () => ({ ok: true }));
    reporter.offer({ version: 'v1', rejected: [] }, ok);
    await vi.waitFor(() => expect(ok).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reporter.offer({ version: 'v1', rejected: [] }, ok);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ok).toHaveBeenCalledTimes(1);

    const notFound = vi.fn(async () => {
      throw Object.assign(new Error('404'), { status: 404 });
    });
    reporter.offer({ version: 'v2', rejected: [] }, notFound);
    await vi.waitFor(() => expect(notFound).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reporter.offer({ version: 'v2', rejected: [] }, notFound);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('does not send the same version twice while the first send is still out', async () => {
    const reporter = new PublicConfigDeliveryReporter();
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    reporter.offer({ version: 'v1', rejected: [] }, slow);
    reporter.offer({ version: 'v1', rejected: [] }, slow);
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe('the saved copy', () => {
  function fakeRedis() {
    const data = new Map<string, string>();
    return {
      data,
      redis: {
        get: vi.fn(async (key: string) => data.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
          data.set(key, value);
          return 'OK';
        }),
        del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
      },
    };
  }

  it('is kept under the version it is saved with, and read back with it', async () => {
    const { data, redis } = fakeRedis();
    const persistence = new RedisPublicConfigPersistence({
      redis: redis as never,
      rejectionNotifier: { rejected: vi.fn(), fieldsRejected: vi.fn(), accepted: vi.fn() },
      store: new RedisLastKnownGoodStore({ redis: redis as never }),
    });

    await persistence.save(PREVIOUS, 'f'.repeat(32));

    expect(JSON.parse(data.get('reiwa:lkg:public-config:v1') as string).hash).toBe('f'.repeat(32));
    expect(await persistence.loadServed()).toEqual({ snapshot: PREVIOUS, version: 'f'.repeat(32) });
    expect(await persistence.load()).toEqual(PREVIOUS);
  });
});
