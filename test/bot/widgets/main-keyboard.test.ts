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
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { InlineKeyboard } from 'grammy';

import {
  buildMainKeyboard,
  isLocalAddress,
  isTelegramSafeButtonUrl,
  resolveBinding,
  supportPrefill,
} from '../../../src/bot/widgets/main-keyboard.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
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
    // The plans page. It was `/subscribe`, a page the cabinet never had.
    expect(resolveBinding('vpn')).toEqual({ kind: 'webapp', path: '/plans' });
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
    // No Mini App either: with one, «Кабинет» is a Mini App button now and does
    // not need `publicWebUrl` at all (see «Кабинет» → the browser, below).
    const kb = buildKb([btn({ id: 'cabinet', label: 'Cabinet' })], null, null);
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
    // Without an HTTPS Mini App (dev) «Кабинет» stays the link it always was.
    const kb = buildKb([btn({ id: 'cabinet', label: 'Cabinet' })], null);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    expect((flat[0] as { url?: string }).url).toBe('https://example.com/');
  });

  it('builds webapp buttons with miniAppUrl + binding.path', () => {
    const kb = buildKb([btn({ id: 'vpn', label: 'VPN' })]);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    expect((flat[0] as { web_app?: { url: string } }).web_app?.url).toBe(
      'https://example.com/app/plans',
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

describe('«Кабинет» → the browser, through the Mini App', () => {
  // The owner's decision of 22.09.2026: «Кабинет» opens the cabinet in the
  // phone's own browser, signed in. It does so by opening the Mini App's
  // `/open-in-browser`, which Telegram signs in at the moment of the tap —
  // so nothing is stamped into the message, and nothing there goes stale.
  const TOKEN = 'b'.repeat(64);

  function only(buttons: BotMenuButton[], miniAppUrl: string | null = 'https://cabinet.example') {
    const kb = buildMainKeyboard({
      buttons,
      miniAppUrl,
      publicWebUrl: 'https://cabinet.example',
      lang: 'ru',
      translator: passthroughTranslator,
      signinToken: TOKEN,
    });
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(1);
    return flat[0] as { url?: string; web_app?: { url: string } };
  }

  it('opens the Mini App page for the panel-seeded «Кабинет» — a link with no address', () => {
    const button = only([{ ...btn({ id: 'cabinet', label: 'Кабинет' }), actionType: 'url', actionTarget: null }]);
    expect(button.web_app?.url).toBe('https://cabinet.example/open-in-browser');
    expect(button.url).toBeUndefined();
  });

  it('does the same for a config from before action types, which routes by the built-in map', () => {
    // ANTI-VACUITY for a real trap: the built-in map gives «Кабинет» the path `/`,
    // which must not read as an address the operator typed.
    const button = only([btn({ id: 'cabinet', label: 'Кабинет' })]);
    expect(button.web_app?.url).toBe('https://cabinet.example/open-in-browser');
  });

  it('puts no sign-in key anywhere in the button: the Mini App is signed in by Telegram', () => {
    const button = only([btn({ id: 'cabinet', label: 'Кабинет' })]);
    expect(JSON.stringify(button)).not.toContain(TOKEN);
  });

  it('joins the Mini App address without doubling a slash', () => {
    const button = only([btn({ id: 'cabinet', label: 'Кабинет' })], 'https://cabinet.example/');
    expect(button.web_app?.url).toBe('https://cabinet.example/open-in-browser');
  });

  it('keeps an address the operator typed exactly as it was, key and all', () => {
    const button = only([
      { ...btn({ id: 'cabinet', label: 'Кабинет' }), actionType: 'url', actionTarget: 'https://cabinet.example/plans' },
    ]);
    expect(button.url).toBe(`https://cabinet.example/plans?signin=${TOKEN}`);
    expect(button.web_app).toBeUndefined();
  });

  it('keeps the stamped link where there is no HTTPS Mini App to open', () => {
    for (const miniAppUrl of [null, 'http://localhost:5173']) {
      const button = only([btn({ id: 'cabinet', label: 'Кабинет' })], miniAppUrl);
      expect(button.url).toBe(`https://cabinet.example/?signin=${TOKEN}`);
    }
  });

  it('changes nothing for any other link button', () => {
    const button = only([
      { ...btn({ id: 'plans', label: 'Тарифы' }), actionType: 'url', actionTarget: null },
    ]);
    expect(button.web_app).toBeUndefined();
  });
});

describe('a main-menu button the operator set to «Mini App»', () => {
  // A tester set «Пригласить» to open the referral program and got the Mini
  // App's home screen. What the operator saves goes after the Mini App's own
  // address, so it has to be joined the way the notification sender joins it.
  function webAppUrlOf(actionTarget: string | null, miniAppUrl = 'https://cabinet.example') {
    const kb = buildMainKeyboard({
      buttons: [
        { ...btn({ id: 'invite', label: 'Пригласить' }), actionType: 'webapp', actionTarget },
        btn({ id: 'rules', label: 'Правила', order: 1 }),
      ],
      miniAppUrl,
      publicWebUrl: 'https://cabinet.example',
      lang: 'ru',
      translator: passthroughTranslator,
    });
    const flat = kb.inline_keyboard.flat() as Array<{
      text: string;
      web_app?: { url: string };
      callback_data?: string;
    }>;
    // The rest of the menu is there, whatever becomes of this button.
    expect(flat.some((b) => b.callback_data === 'rules')).toBe(true);
    return flat.find((b) => b.text.includes('Пригласить'))?.web_app?.url;
  }

  it('opens the page picked: `/referrals` on the Mini App address', () => {
    expect(webAppUrlOf('/referrals')).toBe('https://cabinet.example/referrals');
  });

  it('adds the slash a path typed without one lacks, instead of gluing it onto the host', () => {
    expect(webAppUrlOf('referrals')).toBe('https://cabinet.example/referrals');
  });

  it('keeps a page’s parameters, and does not double a slash', () => {
    expect(webAppUrlOf('/promo?code=SALE', 'https://cabinet.example/')).toBe(
      'https://cabinet.example/promo?code=SALE',
    );
  });

  it('opens an https:// address as it was typed', () => {
    expect(webAppUrlOf('https://other.example/page')).toBe('https://other.example/page');
  });

  it('drops a button Telegram would refuse — and only that button, not the menu', () => {
    expect(webAppUrlOf('http://insecure.example/')).toBeUndefined();
  });

  it('keeps a page whose query names a local address: the host is the Mini App’s', () => {
    expect(webAppUrlOf('/a?b=http://localhost')).toBe('https://cabinet.example/a?b=http://localhost');
  });
});

describe('a main-menu button the operator set to «Внешняя ссылка» with a page of the cabinet', () => {
  // A target that is not an address is a page of the cabinet. It was glued onto
  // the cabinet's address as typed, so `plans` opened
  // `https://cabinet.exampleplans` — a host that does not exist. The same class
  // as the Mini App path above.
  function urlOf(actionTarget: string | null, publicWebUrl = 'https://cabinet.example'): string | undefined {
    const kb = buildMainKeyboard({
      buttons: [{ ...btn({ id: 'plans', label: 'Тарифы' }), actionType: 'url', actionTarget }],
      miniAppUrl: null,
      publicWebUrl,
      lang: 'ru',
      translator: passthroughTranslator,
    });
    return (kb.inline_keyboard.flat()[0] as { url?: string } | undefined)?.url;
  }

  it('adds the slash a path typed without one lacks, instead of gluing it onto the host', () => {
    expect(urlOf('plans')).toBe('https://cabinet.example/plans');
  });

  it('keeps a path typed with one, and does not double a slash', () => {
    expect(urlOf('/plans')).toBe('https://cabinet.example/plans');
    expect(urlOf('/plans?tab=trial', 'https://cabinet.example/')).toBe('https://cabinet.example/plans?tab=trial');
  });

  it('opens an https:// address as it was typed', () => {
    expect(urlOf('https://other.example/page')).toBe('https://other.example/page');
  });
});

describe('supportPrefill — the text a support chat opens with', () => {
  const operatorTranslator: TranslatorPort = {
    t: (key) => (key === 'help.contact_prefill' ? ':fire: Здравствуйте! {{GIFT}}' : key),
    resolveButtonLabel: (_id, fallback) => fallback,
  };

  // A `?text=` parameter carries no entities, so the tokens the panel's picker
  // inserts have to become glyphs here — a premium pack emoji its fallback —
  // or support reads `:fire:` itself.
  it('resolves emoji tokens to their glyphs, even for an owner with Premium', () => {
    expect(
      supportPrefill(operatorTranslator, 'ru', {
        botEmojis: DEFAULT_BOT_CONFIG.botEmojis,
        customEmojis: { fire: { id: '5368324170671202286', fallback: '🔥' } },
      }),
    ).toBe('🔥 Здравствуйте! 🎁');
  });

  // Eight support links build this `?text=`. Read anywhere but through
  // `supportPrefill`, the one that forgot shipped the raw token again.
  it('is the only place bot code reads help.contact_prefill', () => {
    const src = resolve(__dirname, '../../../src');
    const readers = (readdirSync(src, { recursive: true }) as string[])
      // The i18n packs hold the default text; everything else is a reader.
      .filter((file) => file.endsWith('.ts') && !file.split(sep).includes('packs'))
      .filter((file) => readFileSync(join(src, file), 'utf8').includes("t('help.contact_prefill'"))
      .map((file) => file.split(sep).join('/'));
    expect(readers).toEqual(['bot/widgets/main-keyboard.ts']);
  });
});

// «Написать в поддержку» with no public support username falls back to a
// callback. It sent the button's own ID, and only `help` is answered: any other
// ID spun and did nothing. The fallback is meant to be the `help` handler.
describe('a main-menu support button with no public support username', () => {
  it('sends `help`, the one callback that answers it, whatever the button’s ID', () => {
    const kb = buildMainKeyboard({
      buttons: [{ ...btn({ id: 'support', label: 'Поддержка' }), actionType: 'support_url', actionTarget: null }],
      miniAppUrl: null,
      publicWebUrl: null,
      lang: 'ru',
      translator: passthroughTranslator,
      supportUrl: null,
    });
    expect(kb.inline_keyboard.flat()).toEqual([{ text: 'Поддержка', callback_data: 'help' }]);
  });

  it('opens the support chat itself when there is a username to open', () => {
    const kb = buildMainKeyboard({
      buttons: [{ ...btn({ id: 'support', label: 'Поддержка' }), actionType: 'support_url', actionTarget: null }],
      miniAppUrl: null,
      publicWebUrl: null,
      lang: 'ru',
      translator: passthroughTranslator,
      supportUrl: 'https://t.me/rezeis_support',
    });
    expect(kb.inline_keyboard.flat()).toEqual([{ text: 'Поддержка', url: 'https://t.me/rezeis_support' }]);
  });
});

// A «Внешняя ссылка» to a local address went out as typed, and Telegram refused
// the whole welcome message for it — every button with it. The rule is the
// panel map's (`isLocalAddress`), which draws such a button as one the bot
// leaves out.
describe('a main-menu «Внешняя ссылка» to a local address', () => {
  function menuWith(actionTarget: string): Array<{ text: string; url?: string; callback_data?: string }> {
    const kb = buildMainKeyboard({
      buttons: [
        { ...btn({ id: 'site', label: 'Сайт' }), actionType: 'url', actionTarget },
        btn({ id: 'rules', label: 'Правила', order: 1 }),
      ],
      miniAppUrl: null,
      publicWebUrl: 'https://cabinet.example',
      lang: 'ru',
      translator: passthroughTranslator,
    });
    return kb.inline_keyboard.flat() as Array<{ text: string; url?: string; callback_data?: string }>;
  }

  it.each(['http://localhost:3000/plans', 'https://127.0.0.1/x', 'HTTP://LOCALHOST/', '  http://localhost  '])(
    'leaves out %j — only that button, not the menu',
    (target) => {
      expect(menuWith(target)).toEqual([{ text: 'Правила', callback_data: 'rules' }]);
    },
  );

  it('keeps an http:// address that is not local: the panel saves it, and Telegram opens it', () => {
    expect(menuWith('http://example.com/page')[0]).toEqual({ text: 'Сайт', url: 'http://example.com/page' });
  });

  // The host decides, not a substring: the cabinet's own page whose query names
  // a local address went out in the release, and the map draws it as working.
  it('keeps a page of the cabinet whose query names a local address', () => {
    expect(menuWith('/r?next=http://localhost/x')[0]).toEqual({
      text: 'Сайт',
      url: 'https://cabinet.example/r?next=http://localhost/x',
    });
  });
});

// The rule the panel map's copies follow too, pinned by the same table there:
// `new URL(address).hostname` is exactly `localhost` or `127.0.0.1`; an address
// that does not parse is not local.
describe('isLocalAddress — the host, exactly', () => {
  it.each([
    ['http://localhost', true],
    ['http://localhost:3000/x', true],
    ['https://LOCALHOST/x', true],
    ['http://127.0.0.1:8080', true],
    ['https://localhost.example.com', false],
    ['https://example.com/?next=http://localhost/x', false],
    ['https://cabinet.example/r?next=http://127.0.0.1', false],
    ['not a url', false],
    ['https://example.com', false],
  ] as const)('%s → %s', (address, local) => {
    expect(isLocalAddress(address)).toBe(local);
  });

  it('is what isTelegramSafeButtonUrl reads too: a query naming localhost is not local', () => {
    expect(isTelegramSafeButtonUrl('https://example.com/?next=http://localhost/x')).toBe(true);
    expect(isTelegramSafeButtonUrl('https://localhost.example.com/')).toBe(true);
    expect(isTelegramSafeButtonUrl('https://LOCALHOST/x')).toBe(false);
  });
});
