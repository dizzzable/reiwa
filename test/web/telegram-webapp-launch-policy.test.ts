import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../../web/src/hooks/use-telegram-webapp.ts', import.meta.url), 'utf8');
const attribution = readFileSync(new URL('../../web/src/hooks/use-ad-attribution.ts', import.meta.url), 'utf8');
const bootstrap = readFileSync(
  new URL('../../web/src/features/auth/tma-bootstrap-page.tsx', import.meta.url),
  'utf8',
);
const webHome = readFileSync(
  new URL('../../web/src/features/auth/web-home-page.tsx', import.meta.url),
  'utf8',
);
const session = readFileSync(
  new URL('../../web/src/hooks/use-session.ts', import.meta.url),
  'utf8',
);

describe('Telegram Mini App launch policy', () => {
  it('keeps native activation at the application root and makes it idempotent', () => {
    expect(app).toContain('useTelegramWebApp();');
    expect(hook).toContain('const activatedApps = new WeakSet<object>()');
    expect(hook).toContain('if (activatedApps.has(tg)) return');
    expect(hook).toContain('if (activate) activateTelegramWebApp(tg)');
  });

  it('uses passive Telegram readers for attribution and bootstrap consumers', () => {
    expect(attribution).toContain('useTelegramWebApp({ activate: false })');
    expect(bootstrap).toContain('useTelegramWebApp({ activate: false })');
  });

  it('contains SDK exceptions and reports their native lifecycle stage', () => {
    expect(hook).toContain("kind: 'telegram.webapp.initialization'");
    expect(hook).toContain("callTelegramWebAppMethod('ready'");
    expect(hook).toContain("callTelegramWebAppMethod('expand'");
  });

  it('never downgrades a Telegram launch because of the regular web timeout', () => {
    expect(hook).toContain('const launchedByTelegram = hasTelegramLaunchParameters()');
    expect(hook).toContain("window.addEventListener('reiwa:telegram-sdk-ready'");
    expect(hook).toContain("window.addEventListener('reiwa:telegram-sdk-error'");
    expect(hook).toContain("window.__reiwaTelegramSdkState === 'error'");
    expect(hook).toContain("window.__reiwaTelegramSdkState === 'ready'");
    expect(hook).toContain('let sdkReadyFallbackTimeout: number | null = null');
    // The bounded 2s wait must stay gated on a NON-Telegram launch. This used
    // to be pinned as the literal `const timeout = launchedByTelegram ? null :
    // …`, which stopped existing when the wait became a shared, backed-off
    // waiter with a blackhole ceiling. The RULE is unchanged and is what gets
    // asserted now: a launch WITH Telegram parameters is bounded only by the
    // ~20s ceiling (`POLL_CEILING_MS`), never by the regular web timeout, so a
    // slow network can still not downgrade Mini App authentication to web.
    expect(
      hook,
      'the regular 2s web timeout is no longer gated on a non-Telegram launch — a slow network can now downgrade Mini App auth to web',
    ).toMatch(
      /if \(launchedByTelegram\) \{(?:(?!\bPOLL_TIMEOUT_MS\b)[\s\S])*?POLL_CEILING_MS[\s\S]*?\} else \{[\s\S]*?POLL_TIMEOUT_MS/,
    );
  });
});

describe('entry-page session probe', () => {
  it('probes the cookie through the one shared session query, on both entry pages', () => {
    // `useSession()` is mounted app-wide (ad-attribution) and fires
    // `/api/v1/session` on the same mount these pages do their probe. Calling
    // `getSession()` directly here is therefore a guaranteed duplicate
    // round-trip on the very first screen; going through `fetchQuery` with the
    // shared key/fetcher collapses the two into one.
    expect(session).toContain('export async function fetchSessionOrNull(');
    expect(session).toContain('export const SESSION_STALE_TIME_MS');

    for (const [name, source] of [
      ['tma-bootstrap-page', bootstrap],
      ['web-home-page', webHome],
    ] as const) {
      expect(
        source,
        `${name} calls getSession() directly — a second concurrent /api/v1/session next to the one useSession() already has in flight`,
      ).not.toMatch(/\bawait getSession\(\)/);
      expect(
        source,
        `${name} no longer probes through the shared ['session'] query key, so its request cannot be deduplicated`,
      ).toMatch(/fetchQuery\(\{\s*queryKey: SESSION_QUERY_KEY,\s*queryFn: fetchSessionOrNull,/);
    }
  });
});
