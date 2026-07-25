import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../../web/src/hooks/use-telegram-webapp.ts', import.meta.url), 'utf8');
const attribution = readFileSync(new URL('../../web/src/hooks/use-ad-attribution.ts', import.meta.url), 'utf8');
const bootstrap = readFileSync(
  new URL('../../web/src/features/auth/tma-bootstrap-page.tsx', import.meta.url),
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
});
