/**
 * The bot's own copy never names the panel.
 *
 * "Rezeis" is the product an operator RUNS, not the service their customers
 * buy, and this repository carries bot copy of its own in two places that the
 * panel does not reach:
 *
 *   - `DEFAULT_BOT_CONFIG`, which the bot serves when the panel cannot be read
 *     at a cold start and nothing was persisted — its greeting said «Добро
 *     пожаловать в Rezeis VPN.», so an outage handed the vendor's name to every
 *     customer who pressed /start;
 *   - the built-in packs, which answer every key the operator has not
 *     rewritten. `invite.share_prompt` said «Попробуй Rezeis VPN» until the
 *     owner saw it in a customer's «Поделиться» (fixed 23.09.2026).
 *
 * The bot copy has no brand placeholder to put the operator's name in, so both
 * stay brand-neutral and the operator writes their name in the panel. This
 * checks the class — every pack string, the whole fallback config — so the
 * next one fails here rather than in a customer's chat.
 */
import { describe, expect, it } from 'vitest';

import {
  BotConfigCache,
  DEFAULT_BOT_CONFIG,
} from '../../../src/infrastructure/bot-config/cache.js';
import { buildProfileSummary } from '../../../src/infrastructure/bot-message/message-builder.js';
import { EN_PACK, RU_PACK } from '../../../src/infrastructure/i18n/packs/index.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';

const PANEL_NAME = /rezeis/i;

/** Every string in `value` that names the panel, by its path. */
function pathsNamingThePanel(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return PANEL_NAME.test(value) ? [path] : [];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    pathsNamingThePanel(inner, path === '' ? key : `${path}.${key}`),
  );
}

const translator: TranslatorPort = {
  t: (key) => key,
  resolveButtonLabel: (_id, fallback) => fallback,
};

describe('the greeting while the panel cannot be read', () => {
  it('welcomes the customer without the panel’s name', async () => {
    // A cold start with the panel down and nothing persisted: the cache hands
    // out its fallback, and /start renders the greeting from it.
    const cache = new BotConfigCache({
      fetcher: () => Promise.reject(new Error('panel unreachable')),
      hydrator: { setOverrides: () => undefined },
      fallback: DEFAULT_BOT_CONFIG,
    });
    const config = await cache.get();

    const { text } = buildProfileSummary({
      firstName: 'Анна',
      subscriptions: [],
      welcomeTemplate: config.visual.welcomeMessage,
      botEmojis: config.botEmojis,
      translator,
      lang: 'ru',
    });

    expect(text).not.toMatch(PANEL_NAME);
    // Neutral, not empty: the customer is still greeted by name.
    expect(text).toContain('Анна');
  });

  it('carries the panel’s name nowhere in the fallback config', () => {
    expect(pathsNamingThePanel(DEFAULT_BOT_CONFIG)).toEqual([]);
  });
});

describe('the built-in bot packs', () => {
  it('name the panel in no string', () => {
    expect(pathsNamingThePanel({ ru: RU_PACK, en: EN_PACK })).toEqual([]);
  });
});
