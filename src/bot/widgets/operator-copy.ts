/**
 * Operator copy, resolved for where it is sent.
 *
 * «Тексты бота» overrides ANY translator key, and the panel's emoji picker
 * writes two kinds of token into the text: `:slug:` (a pack emoji) and
 * `{{KEY}}` (a bot-emoji slot). Telegram knows neither — a custom emoji only by
 * its id — so a text the bot hands Telegram with a token still in it reaches
 * the reader as `:fire:`. Which form a token turns into depends on what the
 * place it is sent to can carry, and that is the whole of this module:
 *
 *   • `messageCopy` — a message (or caption) sent WITHOUT a parse mode. Glyphs,
 *     plus a `custom_emoji` entity for a pack emoji with an id when the owner
 *     has Premium. Send the entities (`replyWithEntities` omits an empty list):
 *     the text alone shows only the fallback.
 *   • `htmlCopy` — a message sent with `parse_mode: 'HTML'`, which cannot also
 *     carry entities: the premium emoji as a `<tg-emoji>` tag. The rest of the
 *     markup, and its escaping, stays exactly as it was.
 *   • `markdownV2Copy` — `parse_mode: 'MarkdownV2'`: the premium emoji in
 *     MarkdownV2's own custom-emoji syntax, `![🔥](tg://emoji?id=…)`; a glyph
 *     escaped where MarkdownV2 reserves its characters.
 *   • `markdownCopy` — legacy `parse_mode: 'Markdown'`, which has no
 *     custom-emoji syntax: glyphs, escaped where it reserves characters.
 *   • `plainCopy` — text that carries no entities at all: a toast, a link's
 *     `?text=`, a command description, the bot's profile, a refused checkout's
 *     message. Glyphs only, whatever the owner's Premium: a premium pack emoji
 *     arrives as its fallback.
 *
 * Inline-button captions have their own renderers (`inlineButton`,
 * `renderSystemButton`): a caption carries no entities either, but it can carry
 * one icon.
 *
 * `emojis` may be `null` — a config that could not be read. Nothing is
 * substituted then and the text goes out as written: a best-effort send that
 * lost its config must not be lost with it.
 */
import {
  renderBotCopy,
  renderBotCopyHtml,
  resolvePremiumId,
  resolveUnicode,
} from '../../infrastructure/bot-config/emoji-utils.js';
import type { BotConfig, BotEmojiMap, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';

/** The part of the bot config the renderers read (a `BotConfig` is one). */
export type CopyEmojis =
  | {
      readonly botEmojis?: BotEmojiMap | null;
      readonly customEmojis?: BotConfig['customEmojis'] | null;
      readonly botEmojiOwnerHasPremium?: boolean;
    }
  | null
  | undefined;

export function messageCopy(
  text: string,
  emojis: CopyEmojis,
): { text: string; entities: TgCustomEmojiEntity[] } {
  return renderBotCopy(
    text,
    emojis?.botEmojis,
    emojis?.customEmojis,
    emojis?.botEmojiOwnerHasPremium ?? true,
  );
}

export function htmlCopy(text: string, emojis: CopyEmojis): string {
  return renderBotCopyHtml(
    text,
    emojis?.botEmojis,
    emojis?.customEmojis,
    emojis?.botEmojiOwnerHasPremium ?? true,
  );
}

export function plainCopy(text: string, emojis: CopyEmojis): string {
  return renderBotCopy(text, emojis?.botEmojis, emojis?.customEmojis, false).text;
}

/**
 * What a Markdown flavour reserves, and whether it can carry a custom emoji.
 *
 * MarkdownV2 (Bot API "MarkdownV2 style"; TDLib `parse_markdown_v2`, which the
 * Bot API server runs) reserves `_*[]()~`>#+-=|{}.!` outside code and link
 * targets, and writes a custom emoji as `![🔥](tg://emoji?id=…)`. Legacy
 * Markdown reserves `_`, `*`, `` ` `` and `[`, and has no custom emoji at all.
 */
interface MarkdownFlavour {
  readonly reserved: RegExp;
  readonly customEmoji: boolean;
}

const MARKDOWN_V2: MarkdownFlavour = { reserved: /[_*[\]()~`>#+\-=|{}.!\\]/g, customEmoji: true };
const MARKDOWN_LEGACY: MarkdownFlavour = { reserved: /[_*`[]/g, customEmoji: false };

/**
 * One pass over Markdown source, whichever comes first: a span whose content
 * is literal (a pre block, inline code, a link's target), a pack token, a slot,
 * an escaped character. Tokens are matched in both spellings the markup
 * allows: `_`, `{` and `}` are reserved in MarkdownV2 (and `_` in legacy
 * Markdown), so a correctly written text escapes them — `:pack\_one:`,
 * `\{\{GIFT\}\}` — and the raw spelling, which the substitution makes valid by
 * removing it, is a token as well. An escaped character is consumed whole, so
 * `\`` never opens a code span.
 */
const MARKDOWN_SCAN =
  /(```(?:\\[\s\S]|[^`\\])*```|`(?:\\[\s\S]|[^`\\])*`|\]\((?:\\[\s\S]|[^)\\])*\))|:((?:[a-z0-9]|\\?_)+):|\\?\{\\?\{((?:[A-Z0-9]|\\?_)+)\\?\}\\?\}|\\[\s\S]/g;

function markdownCopyIn(flavour: MarkdownFlavour, text: string, emojis: CopyEmojis): string {
  const premium = flavour.customEmoji && (emojis?.botEmojiOwnerHasPremium ?? true);
  const escape = (glyph: string): string => glyph.replace(flavour.reserved, (c) => `\\${c}`);
  const emoji = (glyph: string, id: string | null | undefined): string => {
    // Telegram takes a numeric id only; without one the glyph stands alone.
    const digits = premium ? (id ?? '').replace(/[^0-9]/g, '') : '';
    return digits.length > 0 ? `![${escape(glyph)}](tg://emoji?id=${digits})` : escape(glyph);
  };
  return text.replace(
    MARKDOWN_SCAN,
    (match: string, literal: string | undefined, slug: string | undefined, key: string | undefined) => {
      if (slug !== undefined) {
        // The same rules as `renderBotCopy`: an unknown slug is left as written.
        const entry = emojis?.customEmojis?.[slug.replace(/\\/g, '')];
        if (entry === undefined) return match;
        const fallback = entry.fallback?.trim() ?? '';
        const carrier = fallback.length > 0 ? fallback : entry.id ? '⭐' : '';
        return carrier.length > 0 ? emoji(carrier, entry.id) : match;
      }
      if (key !== undefined) {
        const name = key.replace(/\\/g, '');
        return emoji(resolveUnicode(name, emojis?.botEmojis), resolvePremiumId(name, emojis?.botEmojis));
      }
      // A literal span, or an escaped character.
      return literal ?? match;
    },
  );
}

export function markdownV2Copy(text: string, emojis: CopyEmojis): string {
  return markdownCopyIn(MARKDOWN_V2, text, emojis);
}

export function markdownCopy(text: string, emojis: CopyEmojis): string {
  return markdownCopyIn(MARKDOWN_LEGACY, text, emojis);
}
