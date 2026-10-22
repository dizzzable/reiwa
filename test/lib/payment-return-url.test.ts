/**
 * Spec for source-aware post-payment redirect resolution shared by the
 * single checkout and the combined renewal checkout.
 *
 * Property 8 (combined renewal design): the return URL built for a checkout
 * matches the resolved source — `tma` → the cabinet's way back to Telegram,
 * `web` → web origin — while an explicit client `source` hint wins over the
 * server-detected context.
 *
 * A Mini App payer is sent to the cabinet's `/payment-return/telegram`, never
 * straight to t.me: on Android the gateway's page runs in Telegram's in-app
 * browser, which loaded the t.me redirect as a web page and then failed on its
 * `tg:` hop with net::ERR_UNKNOWN_URL_SCHEME (WATA, 0.9.7.71).
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
  it("sends a Mini App payer to the cabinet's own page back to Telegram, never to t.me", () => {
    expect(buildPaymentReturnUrl({ context: 'tma', config })).toBe(
      'https://reiwa.example/payment-return/telegram',
    );
  });

  it('falls back to the Telegram deep link when the cabinet does not know its address', () => {
    const noDomain = { BOT_USERNAME: 'RezeisBot' } as unknown as ReiwaConfig;
    expect(buildPaymentReturnUrl({ context: 'tma', config: noDomain })).toBe(
      'https://t.me/RezeisBot?start=payment_return',
    );
  });

  it('sends a Mini App payer to the web page when there is no bot to go back to', () => {
    const noBot = { REIWA_DOMAIN: 'reiwa.example' } as unknown as ReiwaConfig;
    expect(buildPaymentReturnUrl({ context: 'tma', config: noBot })).toBe(
      'https://reiwa.example/payment-return',
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

  it('combines resolve + build: a tma-sourced renewal comes back by the way to Telegram', () => {
    const context = resolvePurchaseContext('web', 'tma');
    expect(buildPaymentReturnUrl({ context, config })).toBe(
      'https://reiwa.example/payment-return/telegram',
    );
  });
});
