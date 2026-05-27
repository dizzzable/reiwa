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
