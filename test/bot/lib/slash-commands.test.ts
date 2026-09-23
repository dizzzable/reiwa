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

  // `main.ts` cannot be imported by a spec (it boots the bot), so its two calls
  // are pinned by source: the lists are built with the config it booted with,
  // then with each one a panel push applies. Handed nothing, every description
  // would carry its tokens as typed again.
  it('is registered with the bot config, at boot and on every config push', () => {
    const main = readFileSync(resolve(__dirname, '../../../src/bot/main.ts'), 'utf8');
    const handed = [...main.matchAll(/registerSlashCommands\(bot, logger, (\w+)/g)].map((m) => m[1]);
    expect(handed).toEqual(['botConfig', 'fresh']);
  });
});
