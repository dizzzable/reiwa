/**
 * The command list Telegram shows in the `/` autocomplete, in one language.
 *
 * The `command` is fixed — Telegram routes by the literal string — but each
 * description is a translator key (`commands.<command>.description`) the
 * panel's «Тексты бота» overrides, with its emoji picker in the field.
 * `setMyCommands` takes plain text, no entities, so every `:slug:` / `{{KEY}}`
 * becomes its glyph here (`plainCopy`); sent raw, the list read `:fire:`.
 *
 * `slashCommandLists` builds the three lists Telegram is given (the default
 * scope and one per language) and a signature of them, and `pushSlashCommands`
 * sends them; `telegram-settings-sync.ts` decides when. So read the
 * descriptions here and nowhere else.
 */
import { GrammyError, type Api } from 'grammy';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import { BOT_COMMANDS, type BotCommand } from '../../core/enums/command.enum.js';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../core/enums/locale.enum.js';
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

/** What Telegram is given: the default scope, and one list per supported language. */
export interface SlashCommandLists {
  /**
   * The list of the default scope — a user whose Telegram language has no list
   * of its own. Russian, as it has always been registered.
   */
  readonly defaultScope: ReadonlyArray<{ command: BotCommand; description: string }>;
  readonly perLocale: ReadonlyArray<{
    readonly lang: SupportedLocale;
    readonly commands: ReadonlyArray<{ command: BotCommand; description: string }>;
  }>;
  /**
   * Every description of every language, as one string: equal when nothing
   * Telegram shows would change. The default scope's list is the Russian one,
   * so the languages cover it.
   */
  readonly signature: string;
}

/**
 * The lists as the translator and the config's emoji say now. The translator
 * is hydrated with a config's texts when that config is read (`BotConfigCache`),
 * so build the lists for a config right after it was read.
 */
export function slashCommandLists(translator: TranslatorPort, emojis: CopyEmojis): SlashCommandLists {
  const perLocale = SUPPORTED_LOCALES.map((lang) => ({ lang, commands: slashCommands(translator, lang, emojis) }));
  return {
    defaultScope: slashCommands(translator, 'ru', emojis),
    perLocale,
    signature: perLocale
      .map(({ commands }) => commands.map(({ command, description }) => `${command}=${description}`).join('|'))
      .join('||'),
  };
}

/** How a push went: through whole, or not — with Telegram's `retry_after` when it asked for a pause. */
export type SlashCommandsPushOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly retryAfterMs: number | null };

/** What a failed Bot API call asks the caller to wait, when it is a 429 that says. */
export function retryAfterMsOf(err: unknown): number | null {
  if (!(err instanceof GrammyError)) return null;
  const seconds = err.parameters?.retry_after;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds) * 1000;
  return null;
}

/**
 * Send the lists: the default scope, then one per language. Never throws — the
 * bot works without command suggestions — and says whether every scope went
 * through, so what failed is sent again next time.
 */
export async function pushSlashCommands(
  api: Pick<Api, 'setMyCommands'>,
  lists: SlashCommandLists,
  logger?: Pick<LoggerPort, 'info' | 'warn'>,
): Promise<SlashCommandsPushOutcome> {
  let failed = false;
  let retryAfterMs: number | null = null;
  const noteFailure = (err: unknown): void => {
    failed = true;
    const wait = retryAfterMsOf(err);
    if (wait !== null) retryAfterMs = Math.max(retryAfterMs ?? 0, wait);
  };

  // Telegram's TLS endpoint is occasionally flaky during cold starts
  // (`ECONNRESET` mid-handshake). Retry the default scope once after a small
  // backoff so the catch-all still gets registered when the boot happens to
  // coincide with a TLS reset — but not a 429: asking again at once is what
  // it asked us not to do.
  try {
    await api.setMyCommands([...lists.defaultScope]);
  } catch (firstErr: unknown) {
    if (retryAfterMsOf(firstErr) !== null) {
      noteFailure(firstErr);
      logger?.warn({ err: firstErr }, 'setMyCommands (default scope) rate-limited');
    } else {
      logger?.warn({ err: firstErr }, 'setMyCommands (default scope) failed — retrying once');
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        await api.setMyCommands([...lists.defaultScope]);
      } catch (retryErr: unknown) {
        noteFailure(retryErr);
        logger?.warn(
          { err: retryErr },
          'setMyCommands (default scope) retry failed — leaving per-locale scopes only',
        );
      }
    }
  }

  for (const { lang, commands } of lists.perLocale) {
    try {
      await api.setMyCommands([...commands], { language_code: lang });
    } catch (err: unknown) {
      noteFailure(err);
      logger?.warn({ err, lang }, 'setMyCommands (per-locale scope) failed');
    }
  }
  logger?.info(
    { commandCount: BOT_COMMANDS.length, scopes: lists.perLocale.length + 1, complete: !failed },
    'Bot slash-commands registered',
  );
  return failed ? { kind: 'failed', retryAfterMs } : { kind: 'done' };
}
