import { describe, expect, it, vi } from 'vitest';

import type { PublicConfigSnapshot } from '../../../src/application/ports/public-config-persistence.port.js';
import { REIWA_BUILD_INFO } from '../../../src/core/version.js';
import { BotConfigCache, DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import { RedisConfigPersistence } from '../../../src/infrastructure/bot-config/redis-config-persistence.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import { configVersionOf } from '../../../src/infrastructure/config-versions/config-version.js';
import { createCopyNotSavedReporter } from '../../../src/infrastructure/config-versions/copy-not-saved.js';
import type { LastKnownGoodStorePort } from '../../../src/infrastructure/config-versions/last-known-good.js';
import { createErrorReporter } from '../../../src/infrastructure/error-reporter/index.js';
import { RedisConnectPageSnapshot } from '../../../src/infrastructure/public-config/redis-connect-page-snapshot.js';
import { RedisPublicConfigPersistence } from '../../../src/infrastructure/public-config/redis-public-config-persistence.js';
import { createPublicConfigRejectionNotifier } from '../../../src/infrastructure/public-config/rejection-notifier.js';

/**
 * A settings copy over the saved-copy cap, as the panel receives it.
 *
 * The public config was the only group told (review R2a-07), and it sent the
 * config's version as `version` — which never arrived: the reporter adds the
 * build's identity after the context (`withReiwaBuildInfo`), and its `version`
 * is the cabinet's. The bot config and the connect page told nobody. Each case
 * goes through the REAL error reporter to what it hands the panel client.
 */

/** A panel client that records every report the cabinet sends. */
function panel() {
  const sent: Array<{ source: string; level?: string; message: string; context?: Record<string, unknown> }> = [];
  const client = {
    system: {
      reportError: vi.fn(async (input: (typeof sent)[number]) => {
        sent.push(input);
      }),
    },
  };
  return { sent, errorReporter: (source: 'api' | 'bot') => createErrorReporter({ adminClient: client as never, source }) };
}

/** A store that refuses every save for its size, as the real one does over the cap. */
function store(outcome: 'too-large' | 'saved' = 'too-large'): LastKnownGoodStorePort {
  return {
    load: vi.fn(async () => null) as LastKnownGoodStorePort['load'],
    save: vi.fn(async () => outcome) as LastKnownGoodStorePort['save'],
  };
}

/** A snapshot the public-config guard takes (the one of `public-config-persistence.test.ts`). */
const SNAPSHOT: PublicConfigSnapshot = {
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

const CATALOG = { platforms: [{ id: 'android', apps: [] }] };

const OPERATOR_CONFIG: BotConfig = {
  ...DEFAULT_BOT_CONFIG,
  buttons: [{ id: 'shop', emoji: '', label: 'Operator button', visible: true, order: 0, style: 'primary', onePerRow: true }],
};

describe('a copy over the saved-copy cap reaches the panel with the config’s version', () => {
  it('the public config: `configVersion` is the panel version, and the build’s `version` is still the build’s', async () => {
    const { sent, errorReporter } = panel();
    const persistence = new RedisPublicConfigPersistence({
      redis: {} as never,
      rejectionNotifier: createPublicConfigRejectionNotifier({ errorReporter: errorReporter('api') }),
      store: store(),
    });

    await persistence.save(SNAPSHOT, 'a'.repeat(32));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: 'api', level: 'warning' });
    expect(sent[0]?.context).toMatchObject({
      event: 'reiwa.config.copy_not_saved',
      group: 'public-config',
      configVersion: 'a'.repeat(32),
      bytes: Buffer.byteLength(JSON.stringify(SNAPSHOT), 'utf8'),
      maxBytes: 4 * 1024 * 1024,
      service: 'reiwa',
      version: REIWA_BUILD_INFO.version,
    });
    expect(String(sent[0]?.context?.['why'])).toMatch(/^Оформление кабинета весит .+ больше предела 4,0 МБ/);
  });

  it('the bot config: told once per version, with its size and the 4 MB cap', async () => {
    const { sent, errorReporter } = panel();
    const persistence = new RedisConfigPersistence(
      store(),
      createCopyNotSavedReporter({ errorReporter: errorReporter('bot') }),
    );
    const LATER: BotConfig = { ...OPERATOR_CONFIG, visual: { ...OPERATOR_CONFIG.visual, welcomeMessage: 'later' } };

    // Every read of the panel saves the config again.
    await persistence.save(OPERATOR_CONFIG);
    await persistence.save(OPERATOR_CONFIG);
    await persistence.save(LATER);

    expect(sent.map((report) => report.context?.['configVersion'])).toEqual([
      configVersionOf(OPERATOR_CONFIG),
      configVersionOf(LATER),
    ]);
    expect(sent[0]).toMatchObject({ source: 'bot', level: 'warning' });
    expect(sent[0]?.context).toMatchObject({
      event: 'reiwa.config.copy_not_saved',
      group: 'bot-config',
      bytes: Buffer.byteLength(JSON.stringify(OPERATOR_CONFIG), 'utf8'),
      maxBytes: 4 * 1024 * 1024,
      version: REIWA_BUILD_INFO.version,
    });
    expect(String(sent[0]?.context?.['why'])).toMatch(/^Настройки бота весят .+ больше предела 4,0 МБ/);
  });

  it('the bot config: a Telegram file-id stamp of the same panel answer is not a second report', async () => {
    const { sent, errorReporter } = panel();
    const persistence = new RedisConfigPersistence(
      store(),
      createCopyNotSavedReporter({ errorReporter: errorReporter('bot') }),
    );
    const version = configVersionOf(OPERATOR_CONFIG);
    const stamped: BotConfig = { ...OPERATOR_CONFIG, visual: { ...OPERATOR_CONFIG.visual, bannerFileId: 'AgAC-file-id' } };

    await persistence.save(OPERATOR_CONFIG, version);
    await persistence.save(stamped, version);

    expect(sent.map((report) => report.context?.['configVersion'])).toEqual([version]);
  });

  it('the bot config through its cache: the answer is told once, and its Telegram file-id stamp is no second report', async () => {
    const { sent, errorReporter } = panel();
    const withBanner: BotConfig = {
      ...OPERATOR_CONFIG,
      visual: { ...OPERATOR_CONFIG.visual, bannerUrl: 'https://panel.example/banner.jpg' },
    };
    const cache = new BotConfigCache({
      fetcher: async () => withBanner,
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
      persistence: new RedisConfigPersistence(store(), createCopyNotSavedReporter({ errorReporter: errorReporter('bot') })),
    });

    await cache.get();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    cache.stampBannerFileId('https://panel.example/banner.jpg', 'AgAC-file-id');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent.map((report) => report.context?.['configVersion'])).toEqual([configVersionOf(withBanner)]);
  });

  it('the connect page: told once per version, with its size and the 2 MB cap', async () => {
    const { sent, errorReporter } = panel();
    const snapshot = new RedisConnectPageSnapshot({
      redis: {} as never,
      store: store(),
      copyNotSaved: createCopyNotSavedReporter({ errorReporter: errorReporter('api') }),
    });

    await snapshot.save(CATALOG);
    await snapshot.save(CATALOG);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.context).toMatchObject({
      event: 'reiwa.config.copy_not_saved',
      group: 'connect-page',
      configVersion: configVersionOf(CATALOG),
      bytes: Buffer.byteLength(JSON.stringify(CATALOG), 'utf8'),
      maxBytes: 2 * 1024 * 1024,
      version: REIWA_BUILD_INFO.version,
    });
    expect(String(sent[0]?.context?.['why'])).toMatch(/^Экран подключения весит .+ больше предела 2,0 МБ/);
  });

  it('says nothing when the copy was saved', async () => {
    const { sent, errorReporter } = panel();
    const copies = createCopyNotSavedReporter({ errorReporter: errorReporter('bot') });
    await new RedisConfigPersistence(store('saved'), copies).save(OPERATOR_CONFIG);
    await new RedisConnectPageSnapshot({ redis: {} as never, store: store('saved'), copyNotSaved: copies }).save(CATALOG);
    expect(sent).toEqual([]);
  });

  it('a group is told apart from another of the same version', () => {
    const reports: unknown[] = [];
    const copies = createCopyNotSavedReporter({ errorReporter: { report: (report) => reports.push(report) } });
    copies.report('bot-config', { configVersion: 'v', bytes: 5, maxBytes: 4 });
    copies.report('connect-page', { configVersion: 'v', bytes: 5, maxBytes: 4 });
    copies.report('bot-config', { configVersion: 'v', bytes: 5, maxBytes: 4 });
    expect(reports).toHaveLength(2);
  });
});
