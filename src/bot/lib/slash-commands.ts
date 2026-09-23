/**
 * The command list Telegram shows in the `/` autocomplete, in one language.
 *
 * The `command` is fixed — Telegram routes by the literal string — but each
 * description is a translator key (`commands.<command>.description`) the
 * panel's «Тексты бота» overrides, with its emoji picker in the field.
 * `setMyCommands` takes plain text, no entities, so every `:slug:` / `{{KEY}}`
 * becomes its glyph here (`plainCopy`); sent raw, the list read `:fire:`.
 *
 * `registerSlashCommands` in `bot/main.ts` builds three lists from this (the
 * default scope and one per language) and a signature of them, so read the
 * descriptions here and nowhere else.
 */
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import { BOT_COMMANDS, type BotCommand } from '../../core/enums/command.enum.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import { plainCopy, type CopyEmojis } from '../widgets/operator-copy.js';

export function slashCommands(
  translator: TranslatorPort,
  lang: SupportedLocale,
  emojis: CopyEmojis,
): Array<{ command: BotCommand; description: string }> {
  return BOT_COMMANDS.map((command) => ({
    command,
    description: plainCopy(translator.t(`commands.${command}.description`, lang), emojis),
  }));
}
