/**
 * Main keyboard widget specs.
 *
 *   - URL safety gate accepts HTTPS, rejects HTTP / localhost / 127.0.0.1
 *   - resolveBinding maps known buttonIds to their kind, defaults to
 *     `callback` for unknown ids
 *   - buildMainKeyboard:
 *       - filters invisible buttons
 *       - sorts by `order` ascending
 *       - drops `webapp` / `url` buttons when the corresponding URL
 *         is `null` (degraded mode in dev)
 *       - delegates label resolution to the injected TranslatorPort
 *       - prepends `emoji` when `BotMenuButton.emoji` is non-empty
 *       - one-per-row buttons land alone on a row; non-one-per-row
 *         buttons pair up (max 2 per row)
 */
import { describe, expect, it } from 'vitest';
import { InlineKeyboard } from 'grammy';

import {
  buildMainKeyboard,
  isTelegramSafeButtonUrl,
  resolveBinding,
} from '../../../src/bot/widgets/main-keyboard.js';
import type { BotMenuButton } from '../../../src/infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../../src/application/ports/translator.port.js';
import type { SupportedLocale } from '../../../src/core/enums/locale.enum.js';

const passthroughTranslator: TranslatorPort = {
  t: (key) => key,
  resolveButtonLabel: (_id, fallback) => fallback,
};

function btn(over: Partial<BotMenuButton> & { id: string; label: string }): BotMenuButton {
  return {
    id: over.id,
    emoji: over.emoji ?? '',
    label: over.label,
    visible: over.visible ?? true,
    order: over.order ?? 0,
    style: over.style ?? 'default',
    onePerRow: over.onePerRow ?? false,
  };
}

function buildKb(
  buttons: BotMenuButton[],
  miniAppUrl: string | null = 'https://example.com/app',
  publicWebUrl: string | null = 'https://example.com',
  lang: SupportedLocale = 'ru',
  translator: TranslatorPort = passthroughTranslator,
): InlineKeyboard {
  return buildMainKeyboard({ buttons, miniAppUrl, publicWebUrl, lang, translator });
}

describe('isTelegramSafeButtonUrl', () => {
  it('accepts public HTTPS URLs', () => {
    expect(isTelegramSafeButtonUrl('https://example.com')).toBe(true);
    expect(isTelegramSafeButtonUrl('https://reiwa.example/app')).toBe(true);
  });

  it('rejects HTTP', () => {
    expect(isTelegramSafeButtonUrl('http://example.com')).toBe(false);
  });

  it('rejects localhost / 127.0.0.1 even over HTTPS (dev safeguard)', () => {
    expect(isTelegramSafeButtonUrl('https://localhost:5173')).toBe(false);
    expect(isTelegramSafeButtonUrl('https://127.0.0.1:5173')).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isTelegramSafeButtonUrl(null)).toBe(false);
    expect(isTelegramSafeButtonUrl(undefined)).toBe(false);
  });

  it('is case-insensitive on the hostname check', () => {
    expect(isTelegramSafeButtonUrl('https://LOCALHOST:5173')).toBe(false);
  });
});

describe('resolveBinding', () => {
  it('returns the documented binding for known ids', () => {
    expect(resolveBinding('cabinet')).toEqual({ kind: 'url', path: '/' });
    expect(resolveBinding('vpn')).toEqual({ kind: 'webapp', path: '/subscribe' });
    expect(resolveBinding('miniapp')).toEqual({ kind: 'webapp', path: '/' });
  });

  it('defaults to callback for unknown ids', () => {
    expect(resolveBinding('nonsense')).toEqual({ kind: 'callback' });
  });
});

describe('buildMainKeyboard', () => {
  it('returns an InlineKeyboard instance', () => {
    const kb = buildKb([btn({ id: 'help', label: 'Help' })]);
    expect(kb).toBeInstanceOf(InlineKeyboard);
  });

  it('skips invisible buttons', () => {
    const kb = buildKb([
      btn({ id: 'help', label: 'Help', visible: false }),
      btn({ id: 'rules', label: 'Rules' }),
    ]);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    expect(flat[0].text).toBe('Rules');
  });

  it('sorts buttons by order ascending', () => {
    const kb = buildKb([
      btn({ id: 'help', label: 'Help', order: 2, onePerRow: true }),
      btn({ id: 'rules', label: 'Rules', order: 1, onePerRow: true }),
      btn({ id: 'invite', label: 'Invite', order: 0, onePerRow: true }),
    ]);
    const flat = kb.inline_keyboard.flat();
    expect(flat.map((b) => b.text)).toEqual(['Invite', 'Rules', 'Help']);
  });

  it('drops url buttons when publicWebUrl is null', () => {
    const kb = buildKb([btn({ id: 'cabinet', label: 'Cabinet' })], 'https://app.x', null);
    expect(kb.inline_keyboard.flat()).toHaveLength(0);
  });

  it('drops webapp buttons when miniAppUrl is null', () => {
    const kb = buildKb([btn({ id: 'vpn', label: 'VPN' })], null, 'https://x.example');
    expect(kb.inline_keyboard.flat()).toHaveLength(0);
  });

  it('emits callback_data for unknown buttonIds', () => {
    const kb = buildKb([btn({ id: 'nonsense', label: 'X' })]);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    expect((flat[0] as { callback_data?: string }).callback_data).toBe('nonsense');
  });

  it('builds url buttons by concatenating publicWebUrl + binding.path', () => {
    const kb = buildKb([btn({ id: 'cabinet', label: 'Cabinet' })]);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    expect((flat[0] as { url?: string }).url).toBe('https://example.com/');
  });

  it('builds webapp buttons with miniAppUrl + binding.path', () => {
    const kb = buildKb([btn({ id: 'vpn', label: 'VPN' })]);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    expect((flat[0] as { web_app?: { url: string } }).web_app?.url).toBe(
      'https://example.com/app/subscribe',
    );
  });

  it('delegates label resolution to the injected translator', () => {
    const translator: TranslatorPort = {
      t: (key) => key,
      resolveButtonLabel: (id, fallback, lang) => `[${lang}:${id}] ${fallback}`,
    };
    const kb = buildKb(
      [btn({ id: 'help', label: 'Help' })],
      undefined,
      undefined,
      'en',
      translator,
    );
    const flat = kb.inline_keyboard.flat();
    expect(flat[0].text).toBe('[en:help] Help');
  });

  it('prepends button.emoji when present', () => {
    const kb = buildKb([btn({ id: 'help', label: 'Help', emoji: '🆘' })]);
    expect(kb.inline_keyboard.flat()[0].text).toBe('🆘 Help');
  });

  it('places onePerRow buttons on dedicated rows', () => {
    const kb = buildKb([
      btn({ id: 'help', label: 'A', onePerRow: true }),
      btn({ id: 'rules', label: 'B', onePerRow: true }),
    ]);
    const rows = kb.inline_keyboard.filter((r) => r.length > 0);
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveLength(1);
    expect(rows[1]).toHaveLength(1);
  });

  it('pairs non-onePerRow buttons up to 2 per row', () => {
    const kb = buildKb([
      btn({ id: 'help', label: 'A', onePerRow: false }),
      btn({ id: 'rules', label: 'B', onePerRow: false }),
      btn({ id: 'invite', label: 'C', onePerRow: false }),
    ]);
    const rows = kb.inline_keyboard.filter((r) => r.length > 0);
    // First row holds A + B; second row holds C alone.
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(1);
  });
});

/**
 * The one-time sign-in token is a live session credential for five minutes:
 * whoever posts it to `/api/v1/auth/bot-signin` is signed in as this customer.
 * It used to be stamped onto EVERY url button — an operator's link to a news
 * channel or a partner site received it on every press, and since the customer
 * went there instead of to the cabinet, nothing ever spent it.
 */
describe('buildMainKeyboard — where the sign-in token goes', () => {
  const TOKEN = 'a'.repeat(64);

  function urlButton(id: string, target: string | null): BotMenuButton {
    return { ...btn({ id, label: id, onePerRow: true }), actionType: 'url', actionTarget: target };
  }

  function urlsOf(buttons: BotMenuButton[], publicWebUrl: string | null = 'https://cabinet.example'): string[] {
    const kb = buildMainKeyboard({
      buttons,
      miniAppUrl: null,
      publicWebUrl,
      lang: 'ru',
      translator: passthroughTranslator,
      signinToken: TOKEN,
    });
    return kb.inline_keyboard.flat().map((button) => (button as { url?: string }).url ?? '');
  }

  it('signs the customer in on the cabinet button, as before', () => {
    expect(urlsOf([btn({ id: 'cabinet', label: 'Cabinet' })])).toEqual([
      `https://cabinet.example/?signin=${TOKEN}`,
    ]);
  });

  it('carries it onto a cabinet page other than the root, relative or absolute', () => {
    expect(
      urlsOf([
        urlButton('plans', '/plans'),
        urlButton('renew', 'https://cabinet.example/renew?utm_source=tg'),
      ]),
    ).toEqual([
      `https://cabinet.example/plans?signin=${TOKEN}`,
      `https://cabinet.example/renew?utm_source=tg&signin=${TOKEN}`,
    ]);
  });

  it('never hands it to another site', () => {
    const urls = urlsOf([
      urlButton('channel', 'https://t.me/cabinet_news'),
      urlButton('partner', 'https://partner.example/offer'),
      // The same host on another port or scheme is another origin.
      urlButton('port', 'https://cabinet.example:8443/'),
      urlButton('lookalike', 'https://cabinet.example.evil.example/'),
    ]);

    expect(urls).toEqual([
      'https://t.me/cabinet_news',
      'https://partner.example/offer',
      'https://cabinet.example:8443/',
      'https://cabinet.example.evil.example/',
    ]);
    for (const url of urls) expect(url).not.toContain(TOKEN);
  });

  it('compares addresses as a browser reads them, so only another spelling of the HOST loses it', () => {
    // The same origin however it is spelt: letter case and the default port.
    // The button opens the address as a browser writes it back.
    expect(
      urlsOf([
        urlButton('upper', 'https://CABINET.example/renew'),
        urlButton('port443', 'https://cabinet.example:443/plans'),
      ]),
    ).toEqual([
      `https://cabinet.example/renew?signin=${TOKEN}`,
      `https://cabinet.example/plans?signin=${TOKEN}`,
    ]);

    // Another origin, though it may be the same cabinet: the bot cannot tell a
    // mirror from a landing page on another host, so these open without it and
    // the customer signs in there by hand.
    const other = urlsOf([
      urlButton('www', 'https://www.cabinet.example/'),
      urlButton('trailing-dot', 'https://cabinet.example./'),
      urlButton('plain-http', 'http://cabinet.example/'),
      urlButton('mirror', 'https://cabinet-mirror.example/'),
    ]);
    expect(other).toEqual([
      'https://www.cabinet.example/',
      'https://cabinet.example./',
      'http://cabinet.example/',
      'https://cabinet-mirror.example/',
    ]);
    for (const url of other) expect(url).not.toContain(TOKEN);
  });

  it('hands it to nobody when there is no cabinet address to compare with', () => {
    expect(urlsOf([urlButton('site', 'https://cabinet.example/')], null)).toEqual([
      'https://cabinet.example/',
    ]);
  });
});
