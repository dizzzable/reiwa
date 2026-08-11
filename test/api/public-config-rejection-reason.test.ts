/**
 * A rejected public-config snapshot must name the key it rejected.
 *
 * The all-or-nothing decision is deliberate and stays: half-applied branding
 * looks worse than the previous theme. Doing it in silence was not. The guard
 * was one `&&` chain returning a bare `false`; the route threw, the cabinet
 * went on serving the last stored snapshot from Redis and the browser its copy
 * from localStorage, and the appearance stayed frozen for as long as the bad
 * key survived — while the panel showed the new theme and reported the save as
 * successful. Nothing in the log named the field, so nobody could act on it.
 *
 * These specs fix both halves of the fix: the guard hands back WHICH key failed
 * and WHAT was there (bounded, never the payload), and the notifier turns that
 * into an operator-visible warning that states the consequence and does not
 * repeat itself once a minute for as long as the condition lasts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describePublicConfigSnapshot,
  isPublicConfigSnapshot,
  type PublicConfigSnapshot,
} from '../../src/application/ports/public-config-persistence.port.js';
import type { LoggerPort } from '../../src/application/ports/logger.port.js';
import type { ErrorReporter } from '../../src/infrastructure/error-reporter/index.js';
import { createPublicConfigRejectionNotifier } from '../../src/infrastructure/public-config/rejection-notifier.js';
import {
  getPublicConfigPayload,
  resetBrandingCache,
} from '../../src/api/routes/branding.js';

const VALID: PublicConfigSnapshot = {
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
  },
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  defaultCurrency: 'EUR',
  customIcons: [],
};

function withBranding(overrides: Record<string, unknown>): unknown {
  return {
    ...VALID,
    branding: { ...VALID.branding, ...overrides },
  };
}

function withoutBrandingKey(key: string): unknown {
  const branding: Record<string, unknown> = { ...VALID.branding };
  delete branding[key];
  return { ...VALID, branding };
}

describe('public-config rejection names the offending key', () => {
  it('accepts the reference snapshot, with no reason to report', () => {
    expect(describePublicConfigSnapshot(VALID)).toBeNull();
    expect(isPublicConfigSnapshot(VALID)).toBe(true);
  });

  it('blames the exact branding key and reports what was there', () => {
    const rejection = describePublicConfigSnapshot(
      withBranding({ borderRadius: 'rounded-md' }),
    );

    expect(rejection).toEqual({
      key: 'branding.borderRadius',
      reason: 'not-an-allowed-value',
      found: 'string "rounded-md"',
    });
    // The all-or-nothing verdict is unchanged — only now it is attributable.
    expect(isPublicConfigSnapshot(withBranding({ borderRadius: 'rounded-md' }))).toBe(false);
  });

  it('distinguishes an absent key from a wrongly-typed one', () => {
    expect(describePublicConfigSnapshot(withoutBrandingKey('brandName'))).toEqual({
      key: 'branding.brandName',
      reason: 'not-a-non-empty-string',
      found: 'absent',
    });
    expect(describePublicConfigSnapshot(withBranding({ brandName: 42 }))).toEqual({
      key: 'branding.brandName',
      reason: 'not-a-non-empty-string',
      found: 'number 42',
    });
  });

  it('reports an out-of-range number with the bound it missed', () => {
    expect(describePublicConfigSnapshot(withBranding({ cardEffectOpacity: 0 }))).toEqual({
      key: 'branding.cardEffectOpacity',
      reason: 'out-of-range[0.05..1]',
      found: 'number 0',
    });
  });

  it('blames a root-level key without the branding prefix', () => {
    expect(describePublicConfigSnapshot({ ...VALID, defaultCurrency: 42 })).toEqual({
      key: 'defaultCurrency',
      reason: 'not-a-string',
      found: 'number 42',
    });
  });

  it('points at the offending array position, not just the array', () => {
    const rejection = describePublicConfigSnapshot(
      withBranding({
        navItems: [
          { id: 'subscriptions', visible: true },
          { id: 'not-a-destination', visible: true },
        ],
      }),
    );

    expect(rejection?.key).toBe('branding.navItems[1]');
    expect(rejection?.reason).toBe('not-a-valid-nav-item');
  });

  it('names the locale key that a trailing comma in the panel produced', () => {
    expect(describePublicConfigSnapshot({ ...VALID, locales: ['en', ''] })).toEqual({
      key: 'locales',
      reason: 'contains-a-blank-entry',
      found: 'array(length=2)',
    });
  });

  it('never lets the payload itself reach the reason', () => {
    // A logo that fails validation must not drag 512 KB of base64 into the log.
    const hugeLogo = `data:image/png;base64,${'A'.repeat(4096)}!!!`;
    const rejection = describePublicConfigSnapshot(withBranding({ logoUrl: hugeLogo }));

    expect(rejection?.key).toBe('branding.logoUrl');
    expect(rejection?.found).toMatch(/^string\(length=\d+\)$/);
    expect(rejection?.found).not.toContain('base64');
    expect(JSON.stringify(rejection).length).toBeLessThan(200);
  });

  it('summarises structured values instead of unfolding them', () => {
    const rejection = describePublicConfigSnapshot(
      withBranding({ iconColors: { accent: 'rgb(1,2,3)' } }),
    );

    expect(rejection?.key).toBe('branding.iconColors');
    expect(rejection?.found).toBe('object(keys=1)');
  });
});

describe('the accepted set is unchanged by the refactor', () => {
  // Each entry must be rejected exactly as before, and the two entry points
  // must never disagree — `isPublicConfigSnapshot` is now defined in terms of
  // `describePublicConfigSnapshot`, so a weakened check would show up here.
  const REJECTED: readonly [string, unknown][] = [
    ['non-object root', 'not-an-object'],
    ['missing branding', { ...VALID, branding: undefined }],
    ['empty locales', { ...VALID, locales: [] }],
    ['defaultLocale outside locales', { ...VALID, defaultLocale: 'de' }],
    ['non-hex primary', withBranding({ primary: 'rebeccapurple' })],
    ['url() smuggled into the gradient', withBranding({ cardGradient: 'url(https://x/y.png)' })],
    ['unknown bgEffect', withBranding({ bgEffect: 'SOMETHING_NEW' })],
    ['unknown iconColorMode', withBranding({ iconColorMode: 'rainbow' })],
    ['too many card-effect slots', withBranding({ cardEffectsByIndex: new Array(21).fill({ mode: 'inherit' }) })],
    ['duplicate nav destination', withBranding({
      navItems: [
        { id: 'plans', visible: true },
        { id: 'plans', visible: false },
      ],
    })],
    ['navGap above the cap', withBranding({ navGap: 25 })],
    ['ownership source outside the pair', withBranding({ cardGradientSource: 'inherited' })],
    // The four below were measured to be UNGUARDED: their predicates could each
    // be deleted from the validator and the whole suite — 188 files, 2216 tests
    // — stayed green. `brandPaletteSource` is the worst of them, because this
    // very patch added it: the field that decides whether the operator's colours
    // or the concept's reach the cabinet had no test standing behind its
    // validation on the day it shipped.
    //
    // This table is a SAMPLE, not a proof of set equality, and adding rows does
    // not change that. What it does is stop the sample from having a hole
    // exactly where the newest code is.
    ['brand palette source outside the pair', withBranding({ brandPaletteSource: 'inherited' })],
    ['cornerRadii carrying a non-number', withBranding({
      cornerRadii: { cardPx: 18, itemPx: 'wide', pillPx: 9999 },
    })],
    ['pwaIconUrl that is not a string', withBranding({ pwaIconUrl: 42 })],
    ['tagline that is not a string', withBranding({ tagline: { ru: 'привет' } })],
  ];

  it.each(REJECTED)('rejects %s, and both entry points agree', (_label, candidate) => {
    const rejection = describePublicConfigSnapshot(candidate);
    expect(rejection).not.toBeNull();
    expect(isPublicConfigSnapshot(candidate)).toBe(false);
  });

  const ACCEPTED: readonly [string, unknown][] = [
    ['an effect id from a future panel release', withBranding({ cardEffect: 'effectFromAFuturePanelRelease' })],
    ['a conic gradient', withBranding({ cardGradient: 'conic-gradient(from 90deg, #111 0%, #222 100%)' })],
    ['a stacked multi-layer gradient', withBranding({
      cardGradient: 'linear-gradient(#111, #222), repeating-radial-gradient(#333 0 2px, #444 2px 4px)',
    })],
    ['8-digit hex with alpha', withBranding({ primary: '#6750a480' })],
    ['cardPattern set to the literal "none"', withBranding({ cardPattern: 'none' })],
    ['an inherit slot carrying only a gradient', withBranding({
      cardEffectsByIndex: [{ mode: 'inherit', cardGradient: null }],
    })],
    ['unknown forward-compatible top-level fields', { ...VALID, somethingThePanelAddedLater: { a: 1 } }],
  ];

  it.each(ACCEPTED)('still accepts %s', (_label, candidate) => {
    expect(describePublicConfigSnapshot(candidate)).toBeNull();
    expect(isPublicConfigSnapshot(candidate)).toBe(true);
  });
});

interface Recorded {
  readonly ctx: Record<string, unknown>;
  readonly message: string;
}

function createRecordingLogger(): LoggerPort & {
  readonly warnings: Recorded[];
  readonly infos: Recorded[];
} {
  const warnings: Recorded[] = [];
  const infos: Recorded[] = [];
  const logger = {
    warnings,
    infos,
    warn: (ctx: unknown, message?: unknown) => {
      warnings.push({
        ctx: ctx as Record<string, unknown>,
        message: String(message ?? ctx),
      });
    },
    info: (ctx: unknown, message?: unknown) => {
      infos.push({ ctx: ctx as Record<string, unknown>, message: String(message ?? ctx) });
    },
    fatal: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => logger,
  };
  return logger as unknown as LoggerPort & {
    readonly warnings: Recorded[];
    readonly infos: Recorded[];
  };
}

function createRecordingReporter(): ErrorReporter & {
  readonly reports: Parameters<ErrorReporter['report']>[0][];
} {
  const reports: Parameters<ErrorReporter['report']>[0][] = [];
  return { reports, report: (input) => void reports.push(input) };
}

const CARD_EFFECT_OPACITY_REJECTION = {
  key: 'branding.cardEffectOpacity',
  reason: 'out-of-range[0.05..1]',
  found: 'number 0',
} as const;

describe('the rejection reaches the operator, once', () => {
  it('warns with the key and the consequence, and reports it to the panel', () => {
    const logger = createRecordingLogger();
    const errorReporter = createRecordingReporter();
    const notifier = createPublicConfigRejectionNotifier({
      logger,
      errorReporter,
      now: () => 0,
    });

    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);

    expect(logger.warnings).toHaveLength(1);
    const [warning] = logger.warnings;
    expect(warning?.message).toContain('branding.cardEffectOpacity');
    expect(warning?.message).toContain('out-of-range[0.05..1]');
    expect(warning?.message).toContain('number 0');
    // The consequence, spelled out — this is the part nobody could infer.
    expect(warning?.message).toContain('previous snapshot');
    expect(warning?.message).toContain('frozen');
    expect(warning?.ctx).toMatchObject({
      key: 'branding.cardEffectOpacity',
      reason: 'out-of-range[0.05..1]',
      source: 'upstream',
      event: 'reiwa.config.degraded_defaults_used',
    });

    // Beyond the log: the existing ErrorReporter -> rezeis audit log -> Events.
    expect(errorReporter.reports).toHaveLength(1);
    expect(errorReporter.reports[0]?.level).toBe('warning');
    expect(errorReporter.reports[0]?.message).toContain('branding.cardEffectOpacity');
    expect(errorReporter.reports[0]?.context).toMatchObject({
      event: 'reiwa.config.degraded_defaults_used',
    });
  });

  it('stays silent while the same cause repeats on every 60s poll', () => {
    const logger = createRecordingLogger();
    const errorReporter = createRecordingReporter();
    let clock = 0;
    const notifier = createPublicConfigRejectionNotifier({
      logger,
      errorReporter,
      now: () => clock,
    });

    // Ten minutes of polling at the public-config TTL.
    for (let poll = 0; poll <= 10; poll += 1) {
      clock = poll * 60_000;
      notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    }

    expect(logger.warnings).toHaveLength(1);
    expect(errorReporter.reports).toHaveLength(1);
  });

  it('re-asserts a still-frozen appearance after the reminder window', () => {
    const logger = createRecordingLogger();
    let clock = 0;
    const notifier = createPublicConfigRejectionNotifier({ logger, now: () => clock });

    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    clock = 60_000;
    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    clock = 120_000;
    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    expect(logger.warnings).toHaveLength(1);

    clock = 30 * 60_000;
    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);

    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings[1]?.message).toContain('still rejected');
    expect(logger.warnings[1]?.message).toContain('30 min');
    expect(logger.warnings[1]?.ctx['suppressedRepeats']).toBe(3);
  });

  it('reports a different cause immediately, without waiting out the window', () => {
    const logger = createRecordingLogger();
    let clock = 0;
    const notifier = createPublicConfigRejectionNotifier({ logger, now: () => clock });

    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    clock = 60_000;
    notifier.rejected('upstream', {
      key: 'branding.borderRadius',
      reason: 'not-an-allowed-value',
      found: 'string "rounded-md"',
    });

    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings[1]?.message).toContain('branding.borderRadius');
  });

  it('suppresses per source, so one incident is not reported twice', () => {
    const logger = createRecordingLogger();
    const notifier = createPublicConfigRejectionNotifier({ logger, now: () => 0 });

    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    notifier.rejected('redis-load', CARD_EFFECT_OPACITY_REJECTION);

    // Distinct read paths are distinct facts, but each is stated once.
    expect(logger.warnings).toHaveLength(2);
    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    notifier.rejected('redis-load', CARD_EFFECT_OPACITY_REJECTION);
    expect(logger.warnings).toHaveLength(2);
  });

  it('notes recovery and re-arms, so the next freeze is reported again', () => {
    const logger = createRecordingLogger();
    let clock = 0;
    const notifier = createPublicConfigRejectionNotifier({ logger, now: () => clock });

    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    clock = 60_000;
    notifier.accepted('upstream');

    expect(logger.infos).toHaveLength(1);
    expect(logger.infos[0]?.message).toContain('accepted again');

    clock = 120_000;
    notifier.rejected('upstream', CARD_EFFECT_OPACITY_REJECTION);
    expect(logger.warnings).toHaveLength(2);
  });
});

describe('the route that freezes the cabinet names the key while doing it', () => {
  beforeEach(() => {
    resetBrandingCache();
  });

  it('reports the bad upstream key and still serves the previous snapshot', async () => {
    const logger = createRecordingLogger();
    const errorReporter = createRecordingReporter();
    const notifier = createPublicConfigRejectionNotifier({
      logger,
      errorReporter,
      now: () => 0,
    });

    const adminClient = {
      branding: {
        getReiwaPublicConfig: vi.fn(async () => withBranding({ borderRadius: 'rounded-md' })),
      },
    } as never;
    const persistence = {
      load: vi.fn(async () => VALID),
      save: vi.fn(async () => undefined),
    };

    const payload = await getPublicConfigPayload(
      adminClient,
      undefined,
      persistence,
      notifier,
    );

    // All-or-nothing held: the previous snapshot is what the cabinet gets.
    expect(payload.body).toBe(VALID);
    expect(persistence.save).not.toHaveBeenCalled();

    // And the freeze is now attributable, in the log and on the Events page.
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.ctx).toMatchObject({
      source: 'upstream',
      key: 'branding.borderRadius',
    });
    expect(errorReporter.reports).toHaveLength(1);
    expect(errorReporter.reports[0]?.message).toContain('branding.borderRadius');
  });
});
