/**
 * The descriptions in Telegram's `/` autocomplete.
 *
 * Each is a translator key (`commands.<command>.description`) «Тексты бота» can
 * override, with the panel's emoji picker in the field. `setMyCommands` takes
 * plain text — no entities — so every token has to become its glyph before
 * Telegram sees it, or the command list reads `:fire:`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { slashCommands } from '../../../src/bot/lib/slash-commands.js';
import { telegramSettingsOf } from '../../../src/bot/lib/telegram-settings-sync.js';
import { BOT_COMMANDS } from '../../../src/core/enums/command.enum.js';
import {
  OPERATOR_TEXT_GLYPHS,
  buildPassthroughTranslator,
  operatorEmojiConfig,
  withOperatorText,
} from '../pages/helpers.js';

describe('slashCommands', () => {
  it('lists every advertised command, its description in the language asked for', () => {
    expect(slashCommands(buildPassthroughTranslator(), 'en', null)).toEqual(
      BOT_COMMANDS.map((command) => ({ command, description: `en:commands.${command}.description` })),
    );
  });

  it('resolves the operator’s emoji tokens to their glyphs, even for an owner with Premium', () => {
    const translator = withOperatorText(
      buildPassthroughTranslator(),
      BOT_COMMANDS.map((command) => `commands.${command}.description`),
    );
    expect(slashCommands(translator, 'ru', operatorEmojiConfig())).toEqual(
      BOT_COMMANDS.map((command) => ({ command, description: OPERATOR_TEXT_GLYPHS })),
    );
  });

  // `registerSlashCommands` in `bot/main.ts` sends three lists (the default
  // scope and one per language) and a signature of them; a description read
  // anywhere but here is the one that forgot to resolve.
  it('is the only place bot code reads a command description', () => {
    const src = resolve(__dirname, '../../../src');
    const readers = (readdirSync(src, { recursive: true }) as string[])
      // The i18n packs hold the default text; everything else is a reader.
      .filter((file) => file.endsWith('.ts') && !file.split(sep).includes('packs'))
      .filter((file) => readFileSync(join(src, file), 'utf8').includes('`commands.${'))
      .map((file) => file.split(sep).join('/'));
    expect(readers).toEqual(['bot/lib/slash-commands.ts']);
  });

  // The lists that go out are built with the config being pushed — the boot
  // read's, a save's, a later answered read's (`telegram-settings-sync.ts`;
  // `main.ts` wires it, pinned in `main-config-wiring.test.ts`). Handed
  // nothing, every description would carry its tokens as typed again.
  it('is sent with the emoji of the config being pushed, in every scope', async () => {
    const translator = withOperatorText(
      buildPassthroughTranslator(),
      BOT_COMMANDS.map((command) => `commands.${command}.description`),
    );
    const sent: unknown[] = [];
    const api = {
      setMyCommands: async (list: unknown) => {
        sent.push(list);
        return true;
      },
    };
    const prepared = telegramSettingsOf({ bot: { api } as never, translator, miniAppUrl: null })(operatorEmojiConfig());
    expect(await prepared.push('commands')).toEqual({ kind: 'done' });
    expect(sent).toHaveLength(3);
    for (const list of sent) {
      expect(list).toEqual(BOT_COMMANDS.map((command) => ({ command, description: OPERATOR_TEXT_GLYPHS })));
    }
  });
});
