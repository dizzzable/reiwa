/**
 * `buildScreenKeyboard` — a graph screen's «Внутренняя кнопка» (callback).
 *
 * The panel stores the callback data as typed, and its map reads it trimmed
 * (`bot-map-composer.service.ts`): `menu:main ` is drawn as the way to the main
 * menu. The bot sent it as typed, and no handler answers `menu:main ` — the
 * button spun and did nothing while the map showed it working.
 */
import { describe, expect, it } from 'vitest';

import { buildScreenKeyboard } from '../../../src/bot/pages/screen-renderer.js';
import type { BotScreen, BotScreenButton } from '../../../src/infrastructure/bot-config/types.js';

function callbackButton(callbackAction: string | null, col = 0): BotScreenButton {
  return {
    id: `b${col}`,
    labelRu: `Кнопка ${col}`,
    labelEn: '',
    row: 0,
    col,
    action: 'callback',
    targetShortId: null,
    url: null,
    webAppUrl: null,
    callbackAction,
    style: 'default',
    iconCustomEmojiId: null,
  };
}

function screenWith(buttons: BotScreenButton[]): BotScreen {
  return {
    id: 's1',
    shortId: 'scr00001',
    name: 'promo',
    textRu: 'Экран',
    textEn: '',
    parseMode: 'plain',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    isRoot: false,
    buttons,
  };
}

function callbackDataOf(buttons: BotScreenButton[]): unknown[] {
  const kb = buildScreenKeyboard(screenWith(buttons), 'ru', null, null);
  return kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data);
}

describe('buildScreenKeyboard — a callback button', () => {
  it('sends its data trimmed, as the map reads it', () => {
    expect(callbackDataOf([callbackButton('menu:main '), callbackButton('  help', 1)])).toEqual(['menu:main', 'help']);
  });

  it('leaves out a button whose data is only spaces, as it leaves out an empty one', () => {
    expect(callbackDataOf([callbackButton('   '), callbackButton(''), callbackButton('rules', 2)])).toEqual(['rules']);
  });
});
