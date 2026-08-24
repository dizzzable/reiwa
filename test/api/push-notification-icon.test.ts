import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stripComments } from '../support/source-scan.js';

/**
 * THE SERVICE WORKER MUST PREFER THE BRAND THE PANEL SENDS.
 *
 * A service worker is a static asset built long before the operator uploaded
 * anything, so it cannot know the brand — it can only be told. Until
 * 2026-08-24 it was not told: the icon was a literal bundle path, and every
 * subscriber saw the stock mark whatever the operator had configured. The
 * report arrived as a screenshot of a notification reading `Reiwa`.
 *
 * The panel half of this fix now puts a `icon` in the payload (filtered there:
 * no `data:` URIs, which would blow the ~4 KB push budget, and no SVG, which
 * the Android notification shade cannot decode). That half is worth nothing
 * unless this half reads it — and the two ship from different repositories, so
 * nothing but a guard connects them.
 *
 * A service worker cannot be exercised from a unit test, so this reads the
 * source. That is the honest trade: a weaker check that exists beats a
 * behavioural one that does not.
 */
describe('the push handler renders the brand the payload carries', () => {
  const source = stripComments(readFileSync('web/src/sw.ts', 'utf8'));
  const handler = (() => {
    const from = source.indexOf("self.addEventListener('push'");
    expect(from).toBeGreaterThan(-1);
    return source.slice(from, source.indexOf("self.addEventListener('notificationclick'", from));
  })();

  it('reads the icon out of the payload', () => {
    expect(handler).toContain('data.icon');
  });

  it('keeps the bundled mark only as the fallback, never as the value', () => {
    // The defect shape: `icon: '/icons/icon-192x192.png'` as the whole
    // expression. It must appear on the right of a fallback, not alone.
    expect(handler).not.toMatch(/icon:\s*'\/icons\/icon-192x192\.png'/);
    expect(handler).toContain("'/icons/icon-192x192.png'");
  });

  it('still declares the field it reads', () => {
    // ANTI-VACUITY of a different kind: `data.icon` typed nowhere would mean
    // the payload contract drifted apart from what the panel sends.
    expect(stripComments(readFileSync('web/src/sw.ts', 'utf8'))).toMatch(
      /interface WebPushPayload[\s\S]*?readonly icon\?: string[\s\S]*?}/,
    );
  });
});
