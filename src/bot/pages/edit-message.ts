/**
 * In-place message edit helper.
 *
 * STEALTHNET-style navigation: callback handlers replace the text of
 * the existing message instead of spamming the chat with new replies.
 * This keeps the UI feel like a native app — one screen at a time, with
 * a `[◀️ В меню]` button to backtrack.
 *
 * The wrinkle is photo / animation / video messages. `/start` ships a
 * banner-photo, so the welcome message has its content in `caption`,
 * not `text`. `editMessageText` would 400 on those; we have to use
 * `editMessageCaption` instead. For video messages (rare — instruction
 * videos) we delete + re-send because Telegram doesn't allow swapping
 * a video for plain text in place.
 *
 * Caption length is capped at 1024 chars by the Bot API; entities
 * pointing past that boundary get dropped.
 */
import type { Context, InlineKeyboard } from 'grammy';

import type { TgEntity } from '../../infrastructure/bot-config/types.js';

const TELEGRAM_CAPTION_MAX = 1024;

export interface EditMessageOptions {
  readonly text: string;
  readonly entities?: readonly TgEntity[];
  readonly replyMarkup?: InlineKeyboard;
  /**
   * When `'HTML'`, the message is sent with `parse_mode: 'HTML'` (and no
   * entities — Telegram forbids combining the two). Used by screens whose
   * operator-chosen `parseMode` is HTML. On a Telegram parse error (e.g. a
   * stray `<` in legacy copy) we transparently retry as plain text so a
   * delivery is never lost.
   */
  readonly parseMode?: 'HTML';
}

/** True for the Telegram "can't parse entities" 400 family. */
function isParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse|parse entities|unsupported start tag|unclosed|tag .* mismatch|byte offset/i.test(
    msg,
  );
}

export async function editOrReply(
  ctx: Context,
  options: EditMessageOptions,
): Promise<void> {
  const { text, entities, replyMarkup, parseMode } = options;
  const html = parseMode === 'HTML';
  const msg = ctx.callbackQuery?.message;
  const hasPhoto =
    msg !== undefined &&
    'photo' in msg &&
    Array.isArray((msg as { photo?: unknown[] }).photo) &&
    (msg as { photo: unknown[] }).photo.length > 0;
  const hasAnimation =
    msg !== undefined &&
    'animation' in msg &&
    (msg as { animation?: unknown }).animation != null;
  const hasVideo =
    msg !== undefined &&
    'video' in msg &&
    (msg as { video?: unknown }).video != null;

  // Video messages can't be edited in place to a text reply — delete
  // and re-send. Captionless edits also fall through to delete+send.
  if (hasVideo && ctx.chat?.id !== undefined) {
    const chatId = ctx.chat.id;
    await ctx.deleteMessage().catch(() => undefined);
    try {
      await ctx.api.sendMessage(chatId, text, {
        parse_mode: html ? 'HTML' : undefined,
        entities: !html && entities && entities.length > 0 ? [...entities] : undefined,
        reply_markup: replyMarkup,
      });
    } catch (err) {
      if (!html || !isParseError(err)) throw err;
      await ctx.api.sendMessage(chatId, text, { reply_markup: replyMarkup });
    }
    return;
  }

  if (hasPhoto || hasAnimation) {
    // HTML captions are sent as-is (truncating could split a tag); the entity
    // path keeps its 1024-char clamp.
    const truncatedText =
      !html && text.length > TELEGRAM_CAPTION_MAX
        ? text.slice(0, TELEGRAM_CAPTION_MAX - 3) + '...'
        : text;
    const truncatedEntities =
      !html && text.length > TELEGRAM_CAPTION_MAX && entities
        ? entities.filter((e) => e.offset + e.length <= TELEGRAM_CAPTION_MAX - 3)
        : entities;
    try {
      await ctx.editMessageCaption({
        caption: truncatedText,
        parse_mode: html ? 'HTML' : undefined,
        caption_entities:
          !html && truncatedEntities && truncatedEntities.length > 0
            ? [...truncatedEntities]
            : undefined,
        reply_markup: replyMarkup,
      });
    } catch (err) {
      if (!html || !isParseError(err)) throw err;
      await ctx.editMessageCaption({ caption: truncatedText, reply_markup: replyMarkup });
    }
    return;
  }

  // Regular text message — edit text in place.
  try {
    await ctx.editMessageText(text, {
      parse_mode: html ? 'HTML' : undefined,
      entities: !html && entities && entities.length > 0 ? [...entities] : undefined,
      reply_markup: replyMarkup,
    });
  } catch (err) {
    if (!html || !isParseError(err)) throw err;
    await ctx.editMessageText(text, { reply_markup: replyMarkup });
  }
}
