/**
 * The answer to a button press — a toast or an alert — when the operator
 * writes its words.
 *
 * Telegram takes 0-200 characters for it (`answerCallbackQuery`), counted as
 * code points (memory `telegram-length-limits-count-code-points`), and refuses
 * a longer one; the panel takes 8000 for every bot text. A refused answer
 * threw: past the welcome screen after «Подписка подтверждена», past the notice
 * after «Вы ещё не подписаны», or it left the spinner turning (review R2a-08
 * found it on «Меню обновилось»; every other such answer had it too).
 *
 * `answerCallback` cuts the words to fit and never throws: a text Telegram
 * refuses all the same is answered again without one, so the spinner stops,
 * and the caller goes on to draw whatever the press draws.
 */
import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { BotContext } from '../pages/types.js';

/** Telegram's limit for the text of a callback answer, in code points. */
export const CALLBACK_ANSWER_MAX_CHARS = 200;

function codePointLength(text: string): number {
  let length = 0;
  for (const _codePoint of text) length += 1;
  return length;
}

/**
 * `text` cut to fit a callback answer, at whole characters as a reader sees
 * them — a flag or a keycap is several code points — and closed with «…».
 */
export function fitCallbackAnswer(text: string): string {
  if (codePointLength(text) <= CALLBACK_ANSWER_MAX_CHARS) return text;
  const room = CALLBACK_ANSWER_MAX_CHARS - 1;
  let kept = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const size = codePointLength(segment);
    if (used + size > room) break;
    kept += segment;
    used += size;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * Answer the press — its toast or alert cut to Telegram's limit — so that
 * nothing after it depends on the answer. Without `answer`, the spinner only.
 * Never throws.
 */
export async function answerCallback(
  ctx: BotContext,
  answer?: { readonly text: string; readonly show_alert?: boolean },
  logger?: LoggerPort,
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(answer === undefined ? undefined : { ...answer, text: fitCallbackAnswer(answer.text) });
    return;
  } catch (err: unknown) {
    logger?.warn({ err, telegramId: ctx.from?.id }, 'bot: the press was not answered');
  }
  if (answer !== undefined) await ctx.answerCallbackQuery().catch(() => undefined);
}
