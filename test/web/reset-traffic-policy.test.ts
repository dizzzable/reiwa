import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  freeResetsLeftAfter,
  isFreeResetTraffic,
  resolveAddOnPickPath,
} from '../../web/src/features/addons/reset-traffic-policy.js';

const pageSource = readFileSync(
  fileURLToPath(new URL('../../web/src/features/addons/addons-page.tsx', import.meta.url)),
  'utf8',
);

const reset = (allowance: {
  freeUsesPerTerm: number;
  freeRemaining: number;
  isFree: boolean;
} | null) => ({ type: 'RESET_TRAFFIC', freeAllowance: allowance });

describe('isFreeResetTraffic', () => {
  it('is free only when the server says the allowance covers it', () => {
    expect(isFreeResetTraffic(reset({ freeUsesPerTerm: 1, freeRemaining: 1, isFree: true }))).toBe(
      true,
    );
    expect(isFreeResetTraffic(reset({ freeUsesPerTerm: 1, freeRemaining: 0, isFree: false }))).toBe(
      false,
    );
  });

  it("trusts the server's verdict over the remaining count when they disagree", () => {
    // The operator dropped the allowance to zero mid-term. A page that recomputed
    // "free" from `freeRemaining` would offer a free reset the backend refuses,
    // and the customer would be told the action failed for no visible reason.
    expect(isFreeResetTraffic(reset({ freeUsesPerTerm: 0, freeRemaining: 2, isFree: false }))).toBe(
      false,
    );
  });

  it('falls back to paid when the backend predates the allowance field', () => {
    // Cabinet and API ship as separate images. A missing field must cost a price
    // shown where none was due — never a charge silently skipped.
    expect(isFreeResetTraffic({ type: 'RESET_TRAFFIC' })).toBe(false);
    expect(isFreeResetTraffic(reset(null))).toBe(false);
  });

  it('never treats a non-reset add-on as a free reset', () => {
    expect(
      isFreeResetTraffic({
        type: 'EXTRA_TRAFFIC',
        freeAllowance: { freeUsesPerTerm: 1, freeRemaining: 1, isFree: true },
      }),
    ).toBe(false);
  });
});

describe('resolveAddOnPickPath', () => {
  it('sends a free reset straight to the confirmation, bypassing checkout', () => {
    expect(
      resolveAddOnPickPath(reset({ freeUsesPerTerm: 1, freeRemaining: 1, isFree: true })),
    ).toBe('FREE_RESET');
  });

  it('sends a spent reset through the normal checkout', () => {
    // The whole point of the setting: use 2 onwards is an ordinary paid add-on.
    expect(
      resolveAddOnPickPath(reset({ freeUsesPerTerm: 1, freeRemaining: 0, isFree: false })),
    ).toBe('CHECKOUT');
  });

  it('sends extra traffic and extra devices through checkout', () => {
    expect(resolveAddOnPickPath({ type: 'EXTRA_TRAFFIC' })).toBe('CHECKOUT');
    expect(resolveAddOnPickPath({ type: 'EXTRA_DEVICES' })).toBe('CHECKOUT');
  });
});

describe('freeResetsLeftAfter', () => {
  it('reports what is left once this reset is taken', () => {
    expect(freeResetsLeftAfter(reset({ freeUsesPerTerm: 3, freeRemaining: 3, isFree: true }))).toBe(
      2,
    );
    expect(freeResetsLeftAfter(reset({ freeUsesPerTerm: 1, freeRemaining: 1, isFree: true }))).toBe(
      0,
    );
  });

  it('never goes negative on a stale page', () => {
    expect(freeResetsLeftAfter(reset({ freeUsesPerTerm: 1, freeRemaining: 0, isFree: true }))).toBe(
      0,
    );
    expect(freeResetsLeftAfter({ type: 'RESET_TRAFFIC' })).toBe(0);
  });
});

describe('the add-ons page uses this policy', () => {
  // Guards the failure this whole suite would otherwise miss: a policy that is
  // correct in isolation and simply never reached, because the page kept its own
  // inline copy of the decision.
  it('routes picks through resolveAddOnPickPath rather than an inline check', () => {
    expect(pageSource).toContain('resolveAddOnPickPath(addOn) === "FREE_RESET"');
    expect(pageSource).toContain('isFreeResetTraffic(addOn)');
    expect(pageSource).toContain('freeResetsLeftAfter(props.addOn)');
  });

  it('claims a free reset through its own route, never through purchaseAddOn', () => {
    // A zero-priced trip through checkout would mint a transaction and make the
    // reset look bought — which is exactly what the free path exists to avoid.
    expect(pageSource).toContain('claimFreeTrafficReset(selectedSubscriptionId ?? ""');
  });

  it('states on the card, not only in the dialog, that bought gigabytes survive', () => {
    expect(pageSource).toContain('addons.resetTrafficNote');
  });
});
