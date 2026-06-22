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
 * Replace `:slug:` custom-emoji tokens in an already-rendered (text, entities)
 * pair with the operator's fallback glyph, attaching a Telegram custom-emoji
 * entity when a `custom_emoji_id` is configured (premium render).
 *
 * Runs as a post-pass over the FINAL message so existing entities (premium
 * `{{KEY}}` glyphs, mini-profile icons) are re-based correctly: every token
 * replacement shifts later offsets by `glyphLen - tokenLen`. Tokens whose slug
 * is unknown are left untouched (operators may use `:foo:` literally).
 */
export function applyCustomEmojiTokens(
  text: string,
  entities: readonly TgCustomEmojiEntity[],
  customEmojis?: Record<string, { id: string | null; fallback: string | null }> | null,
): { text: string; entities: TgCustomEmojiEntity[] } {
  if (!customEmojis) return { text, entities: [...entities] };

  const re = /:([a-z0-9_]+):/g;
  interface Replacement {
    readonly start: number;
    readonly end: number;
    readonly carrier: string;
    readonly id: string | null;
  }
  const reps: Replacement[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const entry = customEmojis[match[1]];
    if (entry === undefined) continue;
    const fallback = entry.fallback?.trim() ?? '';
    // Need a visible carrier glyph to host a premium entity; fall back to a
    // neutral star when an id exists but no fallback glyph was provided.
    const carrier = fallback.length > 0 ? fallback : entry.id ? '⭐' : '';
    if (carrier.length === 0 && !entry.id) continue;
    reps.push({ start: match.index, end: match.index + match[0].length, carrier, id: entry.id });
  }
  if (reps.length === 0) return { text, entities: [...entities] };

  let result = '';
  let lastIndex = 0;
  const newEntities: TgCustomEmojiEntity[] = [];
  for (const rep of reps) {
    result += text.slice(lastIndex, rep.start);
    const offset = utf16Length(result);
    result += rep.carrier;
    if (rep.id) {
      newEntities.push({
        type: 'custom_emoji',
        offset,
        length: utf16Length(rep.carrier),
        custom_emoji_id: rep.id,
      });
    }
    lastIndex = rep.end;
  }
  result += text.slice(lastIndex);

  // Re-base pre-existing entities by the net length change of every token
  // replacement that ends at or before the entity's original offset.
  for (const e of entities) {
    let delta = 0;
    for (const rep of reps) {
      if (rep.end <= e.offset) delta += utf16Length(rep.carrier) - (rep.end - rep.start);
    }
    newEntities.push({ ...e, offset: e.offset + delta });
  }

  return { text: result, entities: newEntities };
}

/**
 * Render operator bot copy through BOTH emoji systems in one pass:
 *   1. `{{KEY}}` semantic placeholders → premium custom-emoji / unicode
 *      (the bot-config "Эмодзи" registry), then
 *   2. `:slug:` custom-emoji pack tokens → fallback glyph + premium entity
 *      (the Custom Emoji packs).
 *
 * Every screen that shows operator copy should go through this so the emoji
 * configured in rezeis render consistently everywhere — not just on the
 * welcome screen (which historically was the only caller of the `:slug:`
 * pass, so pack emoji looked "standard" on every other screen).
 */
export function renderBotCopy(
  template: string,
  botEmojis?: BotEmojiMap | null,
  customEmojis?: Record<string, { id: string | null; fallback: string | null }> | null,
  ownerHasPremium: boolean = true,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const placeholders = resolvePlaceholders(template, botEmojis);
  const rendered = applyCustomEmojiTokens(placeholders.text, placeholders.entities, customEmojis);
  if (ownerHasPremium) return rendered;
  return { text: rendered.text, entities: stripCustomEmojiEntities(rendered.entities) };
}

/**
 * Drop `custom_emoji` entities from a rendered result. Telegram rejects a bot
 * message carrying custom-emoji entities when the bot owner has no Premium, so
 * a non-premium deployment renders the fallback glyphs as plain text instead.
 * Pure + total — same `text`, only fewer entities.
 */
export function stripCustomEmojiEntities(
  entities: readonly TgCustomEmojiEntity[],
): TgCustomEmojiEntity[] {
  return entities.filter((e) => e.type !== 'custom_emoji');
}

/**
 * Render an inline-keyboard BUTTON label.
 *
 * Telegram inline-button text can't carry `custom_emoji` entities — the only
 * place a custom emoji renders on a button is the Bot API 9.4
 * `icon_custom_emoji_id` field (a single leading icon, premium owners only).
 * So this helper:
 *   1. Promotes a LEADING `:slug:` / `{{KEY}}` token to `icon_custom_emoji_id`
 *      when it resolves to a premium id, the owner has Premium, and stripping
 *      it still leaves visible label text (Telegram rejects empty labels).
 *   2. Substitutes any remaining `{{KEY}}` → unicode glyph and `:slug:` →
 *      pack fallback glyph as PLAIN TEXT, so a raw `:slug:` never leaks into
 *      the button caption.
 *
 * Unknown `:slug:` tokens (no pack entry) are left untouched so operators can
 * still type a literal `:foo:` if they mean it.
 */
export interface RenderedButtonLabel {
  readonly text: string;
  readonly iconCustomEmojiId?: string;
}

const LEADING_PLACEHOLDER_RE = /^\s*\{\{([A-Z0-9_]+)\}\}\s*/;
const LEADING_SLUG_RE = /^\s*:([a-z0-9_]+):\s*/;
const ALL_PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const ALL_SLUG_RE = /:([a-z0-9_]+):/g;

export function renderButtonLabel(
  label: string,
  botEmojis?: BotEmojiMap | null,
  customEmojis?: Record<string, { id: string | null; fallback: string | null }> | null,
  ownerHasPremium: boolean = true,
): RenderedButtonLabel {
  let iconCustomEmojiId: string | undefined;
  let body = label;

  if (ownerHasPremium) {
    const slugMatch = LEADING_SLUG_RE.exec(body);
    if (slugMatch && customEmojis) {
      const entry = customEmojis[slugMatch[1]];
      const stripped = body.slice(slugMatch[0].length);
      if (entry?.id && stripped.trim().length > 0) {
        iconCustomEmojiId = entry.id;
        body = stripped;
      }
    }
    if (iconCustomEmojiId === undefined) {
      const phMatch = LEADING_PLACEHOLDER_RE.exec(body);
      if (phMatch) {
        const id = resolvePremiumId(phMatch[1], botEmojis);
        const stripped = body.slice(phMatch[0].length);
        if (id !== null && stripped.trim().length > 0) {
          iconCustomEmojiId = id;
          body = stripped;
        }
      }
    }
  }

  let text = body.replace(ALL_PLACEHOLDER_RE, (_m, key: string) =>
    resolveUnicode(key, botEmojis),
  );
  text = text.replace(ALL_SLUG_RE, (m: string, slug: string) => {
    const entry = customEmojis?.[slug];
    if (entry === undefined) return m;
    const fallback = entry.fallback?.trim() ?? '';
    if (fallback.length > 0) return fallback;
    return entry.id !== null ? '⭐' : m;
  });
  text = text.trim();
  if (text.length === 0) text = label.trim();

  return iconCustomEmojiId !== undefined ? { text, iconCustomEmojiId } : { text };
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
