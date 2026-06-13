import type { BotEmojiMap, TgCustomEmojiEntity } from './types.js';

// ── Default Unicode fallbacks (when no tgEmojiId set) ───────────────────────
export const DEFAULT_UNICODE: Record<string, string> = {
  PACKAGE:         '📦',
  TARIFFS:         '📦',
  CARD:            '💳',
  PROMO:           '🎁',
  GIFT:            '🎁',
  REFERRALS:       '👥',
  USERS:           '👥',
  ACTIVITY:        '📊',
  CHART:           '📊',
  MINIAPP:         '📱',
  SUPPORT:         '❓',
  DEVICES:         '🖥',
  BACK:            '◀️',
  PROFILE:         '👤',
  PUZZLE:          '👤',
  TRIAL:           '🆓',
  SERVERS:         '🌐',
  CONNECT:         '🌐',
  STATUS_ACTIVE:   '🟢',
  STATUS_EXPIRED:  '🔴',
  STATUS_DISABLED: '⚫',
  STATUS_LIMITED:  '🟡',
  // Per-subscription mini-profile (greeting summary)
  SUB_PROFILE:     '👤',
  SUB_DEVICES:     '📱',
  SUB_TRAFFIC:     '📈',
  SUB_EXPIRY:      '📅',
  TRAFFIC_OK:      '🟢',
  TRAFFIC_WARN:    '🟠',
  TRAFFIC_FULL:    '🔴',
};

/**
 * Resolve the Telegram Premium custom-emoji id for a semantic key.
 *
 * The id comes solely from the operator-managed `botEmojis[key].tgEmojiId`,
 * which rezeis-admin ships in the bot-config payload (seeded with sensible
 * defaults and editable/clearable in the admin "Эмодзи" editor — the single
 * source of truth). Returns `null` when unset, so the caller renders the
 * unicode glyph without a custom-emoji entity.
 */
export function resolvePremiumId(key: string, botEmojis?: BotEmojiMap | null): string | null {
  const configured = botEmojis?.[key]?.tgEmojiId?.trim();
  return configured && configured.length > 0 ? configured : null;
}

/**
 * Returns the UTF-16 length of the FIRST character in a string.
 * Astral plane code points (> U+FFFF, which includes most emoji) = 2 UTF-16 units.
 */
export function firstCharLengthUtf16(s: string): number {
  if (!s.length) return 0;
  const cp = s.codePointAt(0);
  return cp != null && cp > 0xffff ? 2 : 1;
}

/**
 * Returns the total UTF-16 length of a string.
 * Used to calculate entity offsets when concatenating lines.
 */
export function utf16Length(s: string): number {
  // Each character is either 1 or 2 UTF-16 code units
  let len = 0;
  for (const char of s) {
    const cp = char.codePointAt(0);
    len += cp != null && cp > 0xffff ? 2 : 1;
  }
  return len;
}

/**
 * Resolve the Unicode emoji for a semantic key.
 * Falls back through: botEmojis[key].unicode → DEFAULT_UNICODE[key] → '•'
 */
export function resolveUnicode(key: string, botEmojis?: BotEmojiMap | null): string {
  const entry = botEmojis?.[key];
  return entry?.unicode?.trim() || DEFAULT_UNICODE[key] || '•';
}

/**
 * Build a single line: "EMOJI text" with an optional custom_emoji entity at offset=0.
 *
 * @param key      Semantic emoji key (e.g. 'PACKAGE', 'STATUS_ACTIVE')
 * @param text     Text after the emoji (e.g. 'Мои подписки')
 * @param botEmojis  Emoji map from bot config
 * @returns { text, entities } — entities is empty array if no premium ID configured
 */
export function lineWithEmoji(
  key: string,
  text: string,
  botEmojis?: BotEmojiMap | null,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const unicode = resolveUnicode(key, botEmojis);
  const separator = text.startsWith('\n') ? '' : ' ';
  const fullText = unicode + separator + text;
  const entities: TgCustomEmojiEntity[] = [];

  const premiumId = resolvePremiumId(key, botEmojis);
  if (premiumId) {
    const length = firstCharLengthUtf16(unicode);
    if (length > 0) {
      entities.push({
        type: 'custom_emoji',
        offset: 0,
        length,
        custom_emoji_id: premiumId,
      });
    }
  }

  return { text: fullText, entities };
}

/**
 * Resolve {{KEY}} placeholders in a template string.
 * Replaces each {{KEY}} with its Unicode emoji and optionally emits a custom_emoji entity.
 *
 * @param template   String containing {{KEY}} placeholders, e.g. '{{CARD}} Оплата готова!'
 * @param botEmojis  Emoji map
 * @param baseOffset UTF-16 offset where this template starts in the final message
 */
export function resolvePlaceholders(
  template: string,
  botEmojis?: BotEmojiMap | null,
  baseOffset = 0,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const re = /\{\{([A-Z0-9_]+)\}\}/g;
  const entities: TgCustomEmojiEntity[] = [];
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(template)) !== null) {
    // Append everything before this match
    result += template.slice(lastIndex, match.index);
    const posInOutput = baseOffset + utf16Length(result);

    const key = match[1];
    const unicode = resolveUnicode(key, botEmojis);
    result += unicode;
    lastIndex = match.index + match[0].length;

    // Emit entity if premium ID configured
    const entry = botEmojis?.[key];
    if (entry?.tgEmojiId?.trim()) {
      const length = firstCharLengthUtf16(unicode);
      if (length > 0) {
        entities.push({
          type: 'custom_emoji',
          offset: posInOutput,
          length,
          custom_emoji_id: entry.tgEmojiId.trim(),
        });
      }
    }
  }

  result += template.slice(lastIndex);
  return { text: result, entities };
}

/**
 * Join an array of { text, entities } lines into a single message.
 * Adjusts entity offsets as lines are concatenated with '\n' separators.
 */
export function joinLines(
  lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }>,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const texts: string[] = [];
  const allEntities: TgCustomEmojiEntity[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    texts.push(line.text);

    for (const e of line.entities) {
      allEntities.push({ ...e, offset: e.offset + offset });
    }

    // Move offset forward: UTF-16 length of this line + 1 for the '\n'
    offset += utf16Length(line.text) + 1;
  }

  return {
    text: texts.join('\n'),
    entities: allEntities,
  };
}
