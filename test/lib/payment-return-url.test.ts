/**
 * Spec for source-aware post-payment redirect resolution shared by the
 * single checkout and the combined renewal checkout.
 *
 * Property 8 (combined renewal design): the return URL built for a checkout
 * matches the resolved source — `tma` → Telegram deep link, `web` → web
 * origin — while an explicit client `source` hint wins over the
 * server-detected context.
 */
import { describe, expect, it } from 'vitest';

import type { ReiwaConfig } from '../../src/config.js';
import {
  buildPaymentReturnUrl,
  resolvePurchaseContext,
} from '../../src/lib/payment-return-url.js';

const config = {
  BOT_USERNAME: 'RezeisBot',
  REIWA_DOMAIN: 'reiwa.example',
} as unknown as ReiwaConfig;

describe('resolvePurchaseContext', () => {
  it('prefers an explicit client source over the detected context', () => {
    expect(resolvePurchaseContext('web', 'tma')).toBe('tma');
    expect(resolvePurchaseContext('tma', 'web')).toBe('web');
  });

  it('falls back to the detected context when the hint is absent/invalid', () => {
    expect(resolvePurchaseContext('tma', undefined)).toBe('tma');
    expect(resolvePurchaseContext('tma', 'garbage')).toBe('tma');
    expect(resolvePurchaseContext(undefined, undefined)).toBe('web');
  });
});

describe('buildPaymentReturnUrl (Property 8)', () => {
  it('returns a Telegram deep link for the tma context', () => {
    expect(buildPaymentReturnUrl({ context: 'tma', config })).toBe(
      'https://t.me/RezeisBot?start=payment_return',
    );
  });

  it('returns the web origin for the web context', () => {
    expect(buildPaymentReturnUrl({ context: 'web', config })).toBe(
      'https://reiwa.example/payment-return',
    );
  });

  it('lets an explicit override win over both contexts', () => {
    const override = 'https://reiwa.example/custom-return';
    expect(buildPaymentReturnUrl({ context: 'tma', config, override })).toBe(override);
    expect(buildPaymentReturnUrl({ context: 'web', config, override })).toBe(override);
  });

  it('combines resolve + build: a tma-sourced renewal redirects back to Telegram', () => {
    const context = resolvePurchaseContext('web', 'tma');
    expect(buildPaymentReturnUrl({ context, config })).toBe(
      'https://t.me/RezeisBot?start=payment_return',
    );
  });
});
