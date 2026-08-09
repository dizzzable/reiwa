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

  /**
   * REMOVED — `never downgrades a Telegram launch because of the regular web
   * timeout`, a regex over `use-telegram-webapp.ts`.
   *
   * It read a real file at the wrong LAYER. That hook stopped deciding "Mini
   * App or browser?" in `c087865`: authentication now reads the launch off the
   * URL (`lib/telegram-launch-params.ts`), and the hook only supplies haptics,
   * BackButton/MainButton, theme and `openInvoice`. So the assertion could go
   * green while the thing it named — a launch downgraded to web — happened
   * somewhere it never looked. That is the same failure as the sentinel which
   * read the wrong file for six weeks, one rung up.
   *
   * The rule it meant to protect is now asserted by EXECUTING code:
   *   - bounded wait vs. blackhole ceiling, and `web` staying upgradeable:
   *     `web/test/use-telegram-webapp-poll.test.tsx`
   *   - the launch decision itself surviving a dead telegram.org, on every
   *     route that makes it: `web/test/telegram-launch-slow-sdk.test.tsx`
   *     (`/`, `/bootstrap`), `web/test/tma-bootstrap-auto-login.test.tsx`
   *     (`/tma`), `web/test/telegram-deep-link-launch.test.tsx` (a launch
   *     straight onto a cabinet route), `web/test/claim-link-existing.test.tsx`
   *     (`/claim`).
   */

  /**
   * REMOVED — `describe('entry-page session probe')`, a regex over the two
   * entry pages for `fetchQuery({ queryKey: SESSION_QUERY_KEY, … })`.
   *
   * It asserted PLUMBING, never SEMANTICS: that the call is written a certain
   * way, not that a failed probe still ends in a sign-in. `fetchSessionOrNull`
   * converts a network failure into a successful `null`, so the probe cannot
   * tell "no session" from "could not ask" — and no amount of source text
   * catches what that does at a call site. Now executed, with the probe made to
   * resolve-null and to reject outright, in
   * `web/test/tma-bootstrap-auto-login.test.tsx` and
   * `web/test/telegram-launch-slow-sdk.test.tsx`.
   */
});
