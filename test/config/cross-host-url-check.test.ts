import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config/app.config.js';
import { warnOnUnreachableCrossHostUrls } from '../../src/core/config/cross-host-url-check.js';
import type { Logger } from '../../src/infrastructure/logger/index.js';

/**
 * The whole value of this warning is that it stays silent on a correct
 * single-host install. A warning that cries wolf gets ignored, and an ignored
 * warning is worse than none — so the silence cases are the ones under test.
 */
describe('cross-host URL boot warning', () => {
  const sharedSecret = 's'.repeat(32);

  /** Minimal stand-in for the pino logger: records `warn` calls, ignores the rest. */
  function recordingLogger(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = [];
    const noop = (): void => undefined;
    const logger = {
      warn: (_context: unknown, message?: unknown): void => {
        warnings.push(typeof message === 'string' ? message : String(_context));
      },
      info: noop,
      debug: noop,
      error: noop,
      fatal: noop,
      trace: noop,
      child: () => logger,
    } as unknown as Logger;
    return { logger, warnings };
  }

  /** Every attempt fires on the next macrotask, so a test never waits 5 minutes. */
  const immediate = [0, 0, 0] as const;

  const nxdomain = (_host: string, cb: (e: NodeJS.ErrnoException | null) => void): void => {
    const error: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND');
    error.code = 'ENOTFOUND';
    setImmediate(() => cb(error));
  };
  const resolves = (_host: string, cb: (e: NodeJS.ErrnoException | null) => void): void => {
    setImmediate(() => cb(null));
  };
  const transient = (_host: string, cb: (e: NodeJS.ErrnoException | null) => void): void => {
    const error: NodeJS.ErrnoException = new Error('getaddrinfo EAI_AGAIN');
    error.code = 'EAI_AGAIN';
    setImmediate(() => cb(error));
  };

  /**
   * Lets the three chained probe attempts run to completion. Real elapsed time,
   * not event-loop turns: `setTimeout(fn, 0)` is clamped to 1ms, so draining
   * `setImmediate` never advances it. Three attempts cost ~3ms; 60ms is ample.
   */
  async function settle(): Promise<void> {
    await new Promise((done) => setTimeout(done, 60));
  }

  function productionConfig(overrides: Record<string, string> = {}) {
    return loadConfig({
      NODE_ENV: 'production',
      REIWA_DOMAIN: 'app.example.com',
      REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
      REZEIS_TOKEN: 'issued-by-the-panel',
      REZEIS_HOST: 'rezeis',
      ...overrides,
    });
  }

  it('stays silent on a correct single-host install (the docker name resolves)', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(productionConfig(), logger, {
      lookup: resolves,
      delaysMs: immediate,
    });
    await settle();

    expect(warnings).toEqual([]);
  });

  it('warns when the docker service name does not resolve (split VPS, default left in place)', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(productionConfig(), logger, {
      lookup: nxdomain,
      delaysMs: immediate,
    });
    await settle();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('REZEIS_HOST');
    expect(warnings[0]).toContain('rezeis');
    expect(warnings[0]).toContain('panel.example.com');
  });

  it('stays silent on a transient resolver failure rather than blaming the config', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(productionConfig(), logger, {
      lookup: transient,
      delaysMs: immediate,
    });
    await settle();

    expect(warnings).toEqual([]);
  });

  it('stays silent for a real domain, which is what a correct split VPS sets', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(
      productionConfig({ REZEIS_HOST: 'panel.example.com' }),
      logger,
      { lookup: nxdomain, delaysMs: immediate },
    );
    await settle();

    // Even with DNS failing outright: a domain that is merely down is a
    // different problem with a different fix, and this check must not claim it.
    expect(warnings).toEqual([]);
  });

  it.each(['localhost', '127.0.0.1', '10.0.0.5'])(
    'stays silent for the private literal %s',
    async (host) => {
      const { logger, warnings } = recordingLogger();

      warnOnUnreachableCrossHostUrls(productionConfig({ REZEIS_HOST: host }), logger, {
        lookup: nxdomain,
        delaysMs: immediate,
      });
      await settle();

      expect(warnings).toEqual([]);
    },
  );

  it('stays silent outside production', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(
      loadConfig({
        NODE_ENV: 'development',
        REZEIS_TOKEN: 'issued-by-the-panel',
        REZEIS_HOST: 'rezeis',
      }),
      logger,
      { lookup: nxdomain, delaysMs: immediate },
    );
    await settle();

    expect(warnings).toEqual([]);
  });

  it('stays silent when the upstream is not in use (no REZEIS_TOKEN)', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(
      loadConfig({
        NODE_ENV: 'production',
        REIWA_DOMAIN: 'app.example.com',
        REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
        REZEIS_HOST: 'rezeis',
      }),
      logger,
      { lookup: nxdomain, delaysMs: immediate },
    );
    await settle();

    expect(warnings).toEqual([]);
  });
});
