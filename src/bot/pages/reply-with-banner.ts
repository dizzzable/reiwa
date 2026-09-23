/**
 * replyWithOptionalBanner — fresh-message reply that honours the operator's
 * "use one banner everywhere" setting (`bot.banner_apply_all`).
 *
 * Slash-command pages (e.g. `/help`, `/lang`) send a brand-new message with
 * `ctx.reply(...)`, which carries no banner. The welcome screen (`/start`)
 * has its own banner-send path, but every other command-triggered screen was
 * left plain — so a tester who enabled "banner everywhere" still saw no
 * banner after `/help`. Callback navigation from the welcome photo keeps the
 * banner for free (Telegram `editMessageCaption` preserves the photo), so the
 * gap is specifically the fresh command replies — which this helper closes.
 *
 * When `bannerApplyAll` is off, or no banner is configured / resolvable, it
 * degrades to a plain `ctx.reply` so a delivery is never lost.
 */
import type { InlineKeyboard } from 'grammy';

import type {
  BotContext,
  PageDeps,
} from './types.js';
import type {
  BotConfig,
  TgCustomEmojiEntity,
} from '../../infrastructure/bot-config/types.js';
import { resolveBannerSource, type BannerPhotoSource } from './banner-resolver.js';

const TELEGRAM_CAPTION_MAX = 1024;

/**
 * Telegram's own ceiling on message text. Longer and `sendMessage` answers
 * `400 message is too long`.
 *
 * The caption cap above was honoured from the start; this one was not, and the
 * difference showed on screens whose body an operator types. `BotFlowScreen`
 * text has no maximum in its DTO, so a long rules document pasted into the
 * editor produced a command that failed every time it was used — and failed
 * TWICE, because the HTML-recovery path below resends the same text without a
 * parse mode, which does nothing for a length error. The user got the generic
 * apology instead of the rules.
 */
const TELEGRAM_TEXT_MAX = 4096;

/** One message of a split text: its slice, and the entities that fall in it. */
interface TextPart {
  readonly text: string;
  readonly entities: TgCustomEmojiEntity[];
}

/**
 * Splits text at the last line break before the ceiling, so a long screen
 * arrives as several messages rather than as an error.
 *
 * Cut on a boundary the reader can see: a paragraph break first, then a line
 * break, and only mid-line when a single line is itself longer than the
 * ceiling. Splitting blind would break a word, and worse, could split an HTML
 * tag in half — which turns one rejected message into two.
 *
 * Each part carries the entities that fall in it, at offsets counted from ITS
 * start. They all used to ride on the last part at their offsets in the whole
 * text — out of that part's range, so Telegram refused it with a 400 and the
 * user got the generic apology instead of the screen.
 *
 * The ceiling is in characters, as Telegram counts it (code points — memory
 * `telegram-length-limits-count-code-points`); offsets stay in UTF-16 units,
 * as Telegram reads entities. So a cut always falls between code points, never
 * inside a surrogate pair, and never inside the glyph a custom emoji covers — a
 * flag or a keycap is several code points under one entity: it moves back to
 * where the emoji starts.
 */
function splitForTelegram(
  text: string,
  entities: readonly TgCustomEmojiEntity[],
  limit: number,
): readonly TextPart[] {
  const parts: TextPart[] = [];
  let start = 0;
  while (start < text.length) {
    const windowEnd = afterCodePoints(text, start, limit);
    let end = windowEnd;
    if (windowEnd < text.length) {
      const window = text.slice(start, windowEnd);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
      end = cut > window.length / 2 ? start + cut : windowEnd;
      end = outsideEmoji(end, start, entities);
    }
    parts.push({ text: text.slice(start, end), entities: entitiesWithin(entities, start, end) });
    // The line break that was cut at opens no part.
    start = end;
    while (text[start] === '\n') start += 1;
  }
  return parts;
}

/** The UTF-16 index `count` characters (code points) after `from`, or the end of `text`. */
function afterCodePoints(text: string, from: number, count: number): number {
  let index = from;
  for (let seen = 0; seen < count && index < text.length; seen += 1) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

/**
 * `at`, or the start of the custom emoji it would cut through. A part that
 * would then be empty — an emoji longer than the whole ceiling — keeps the
 * emoji whole instead.
 */
function outsideEmoji(at: number, partStart: number, entities: readonly TgCustomEmojiEntity[]): number {
  const cut = entities.find((e) => e.type === 'custom_emoji' && e.offset < at && at < e.offset + e.length);
  if (cut === undefined) return at;
  return cut.offset > partStart ? cut.offset : cut.offset + cut.length;
}

/** The entities inside `[start, end)`, re-based to `start`; one that crosses a cut is clipped to it. */
function entitiesWithin(
  entities: readonly TgCustomEmojiEntity[],
  start: number,
  end: number,
): TgCustomEmojiEntity[] {
  const inside: TgCustomEmojiEntity[] = [];
  for (const e of entities) {
    const from = Math.max(start, e.offset);
    const to = Math.min(end, e.offset + e.length);
    if (from < to) inside.push({ ...e, offset: from - start, length: to - from });
  }
  return inside;
}

// Telegram file_id cache for the resolved global banner, keyed by the banner
// URL. Mirrors the bounded cache `start.ts` keeps for the welcome banner so
// repeated commands don't re-download the bytes from rezeis.
const bannerFileIdCache = new Map<string, string>();

function rememberFileId(url: string, sent: unknown): string | undefined {
  const photo = (sent as { photo?: Array<{ file_id?: string }> } | undefined)?.photo;
  const fileId =
    Array.isArray(photo) && photo.length > 0 ? photo[photo.length - 1]?.file_id : undefined;
  if (typeof fileId === 'string' && fileId.length > 0) {
    if (bannerFileIdCache.size > 16) bannerFileIdCache.clear();
    bannerFileIdCache.set(url, fileId);
    return fileId;
  }
  return undefined;
}

export interface OptionalBannerReply {
  readonly text: string;
  readonly entities?: readonly TgCustomEmojiEntity[];
  /**
   * Set when the copy is operator-authored HTML (a Bot Studio screen with
   * `parseMode: 'html'`). Mutually exclusive with `entities` — Telegram
   * accepts one or the other, and the callers build one or the other.
   *
   * This existed on the edit path (`renderScreenOrEdit`) long before it
   * existed here, which was fine while only `/help` and `/lang` used this
   * helper — neither renders operator markup. `/rules` does, and without
   * this the command would have shown raw `<b>` tags to the user while the
   * keyboard-button route to the same screen rendered it correctly.
   */
  readonly parseMode?: 'HTML';
  readonly replyMarkup?: InlineKeyboard;
}

/**
 * Send `opts` as a fresh reply, prefixed with the global banner photo when the
 * operator enabled "banner everywhere". Falls back to a plain text reply
 * otherwise (or when the banner can't be resolved / Telegram rejects it).
 */
export async function replyWithOptionalBanner(
  ctx: BotContext,
  deps: PageDeps,
  botCfg: BotConfig,
  opts: OptionalBannerReply,
): Promise<void> {
  // NOTHING TO SEND IS NOT AN ERROR TO SHOW.
  //
  // `BotFlowScreen.textRu` defaults to an empty string and its DTO enforces no
  // minimum, so a screen whose body is only `{{rulesLink}}` on an install with
  // no active legal document resolves to `''`. `ctx.reply('')` earns
  // `400 message text is empty`, which reaches the user as the generic
  // apology — the same outcome as a crash, for a screen the operator simply
  // has not filled in.
  if (opts.text.trim().length === 0) {
    deps.logger?.warn(
      'reply-with-banner: refusing to send an empty message; the screen has no text',
    );
    return;
  }

  const html = opts.parseMode === 'HTML';
  // Entities and `parse_mode` are alternatives, not companions: sending both
  // makes Telegram ignore one of them silently.
  const entities =
    !html && opts.entities && opts.entities.length > 0 ? [...opts.entities] : undefined;

  const visual = botCfg.visual;
  const wantBanner = visual.bannerApplyAll === true;
  const fileId = (visual.bannerFileId ?? '').trim();
  const url = (visual.bannerUrl ?? '').trim();

  if (wantBanner && (fileId.length > 0 || url.length > 0) && opts.text.length <= TELEGRAM_CAPTION_MAX) {
    // Prefer a Telegram file_id (instant, no fetch); else resolve the URL.
    let source: BannerPhotoSource | null = null;
    if (fileId.length > 0) {
      source = fileId;
    } else {
      source =
        bannerFileIdCache.get(url) ??
        (await resolveBannerSource(url, {
          rezeisAdminUrl: deps.urls.rezeisAdminUrl,
          logger: deps.logger
            ? {
                warn: (obj, msg) => {
                  deps.logger?.warn(obj as Record<string, unknown>, msg);
                },
              }
            : undefined,
        }));
    }

    if (source !== null) {
      try {
        const sent = await ctx.replyWithPhoto(source, {
          caption: opts.text,
          parse_mode: html ? 'HTML' : undefined,
          caption_entities: entities,
          reply_markup: opts.replyMarkup,
        });
        // Stamp the resolved file_id (URL path only) so the next command reuses
        // it and a custom banner survives without re-downloading from rezeis.
        if (fileId.length === 0 && url.length > 0 && !bannerFileIdCache.has(url)) {
          const resolved = rememberFileId(url, sent);
          if (resolved !== undefined) deps.rememberBannerFileId?.(url, resolved);
        }
        return;
      } catch (err: unknown) {
        // A stale cached file_id can 400 — drop it so the next call re-uploads.
        if (url.length > 0) bannerFileIdCache.delete(url);
        deps.logger?.warn({ err }, 'reply-with-banner: sendPhoto failed; falling back to text');
      }
    }
  }

  // The keyboard rides the LAST part, so a split document still ends with its
  // buttons rather than putting them in the middle. Each part carries its own
  // entities (`splitForTelegram`).
  const parts = splitForTelegram(opts.text, entities ?? [], TELEGRAM_TEXT_MAX);
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    try {
      await ctx.reply(part.text, {
        parse_mode: html ? 'HTML' : undefined,
        entities: part.entities.length > 0 ? part.entities : undefined,
        reply_markup: last ? opts.replyMarkup : undefined,
      });
    } catch (err: unknown) {
      if (!html) throw err;
      // Operator-authored markup can be malformed, and Telegram rejects the
      // whole message for it. Resend without a parse mode rather than leave the
      // user with nothing: the tags read badly, an empty screen reads as broken.
      deps.logger?.warn({ err }, 'reply-with-banner: HTML rejected; resending as plain text');
      await ctx.reply(part.text, { reply_markup: last ? opts.replyMarkup : undefined });
    }
  }
}
