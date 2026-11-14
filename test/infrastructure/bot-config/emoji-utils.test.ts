/**
 * Bot emoji helper specs.
 *
 * UTF-16 length and entity offset arithmetic is fiddly — every regression
 * here misaligns Telegram custom-emoji rendering on production users.
 * These specs pin the documented invariants:
 *
 *   - astral plane code points (most emoji) count as 2 UTF-16 units
 *   - `lineWithEmoji` emits a custom_emoji entity at offset 0 with the
 *     UTF-16 length of the leading emoji (1 or 2 units)
 *   - `joinLines` shifts every entity offset forward by the cumulative
 *     UTF-16 length of preceding lines plus their `\n` separators
 *   - `resolvePlaceholders` resolves `{{KEY}}` against the emoji map
 *     and emits entities at the correct UTF-16 offset, even when
 *     multiple placeholders appear on the same line
 *   - missing keys fall back through unicode → DEFAULT_UNICODE → "•"
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNICODE,
  firstCharLengthUtf16,
  glyphLengthUtf16,
  joinLines,
  lineWithEmoji,
  lineWithEmojiAndDot,
  resolvePlaceholders,
  resolveUnicode,
  utf16Length,
  applyCustomEmojiTokens,
  renderBotCopy,
  stripCustomEmojiEntities,
} from '../../../src/infrastructure/bot-config/emoji-utils.js';

describe('firstCharLengthUtf16', () => {
  it('returns 0 for an empty string', () => {
    expect(firstCharLengthUtf16('')).toBe(0);
  });

  it('returns 1 for an ASCII char', () => {
    expect(firstCharLengthUtf16('A')).toBe(1);
  });

  it('returns 1 for a BMP non-ASCII char', () => {
    expect(firstCharLengthUtf16('é')).toBe(1);
  });

  it('returns 2 for an astral-plane emoji (📦, U+1F4E6)', () => {
    expect(firstCharLengthUtf16('📦')).toBe(2);
  });
});

describe('utf16Length', () => {
  it('counts ASCII characters as 1 unit each', () => {
    expect(utf16Length('hello')).toBe(5);
  });

  it('counts emoji as 2 units each', () => {
    expect(utf16Length('📦📦')).toBe(4);
  });

  it('mixes ASCII and emoji correctly', () => {
    expect(utf16Length('a📦b')).toBe(4);
  });
});

describe('resolveUnicode', () => {
  it('prefers the bot-config override unicode value', () => {
    expect(resolveUnicode('PACKAGE', { PACKAGE: { unicode: '🎁' } })).toBe('🎁');
  });

  it('falls back to DEFAULT_UNICODE when override is missing', () => {
    expect(resolveUnicode('PACKAGE')).toBe(DEFAULT_UNICODE['PACKAGE']);
  });

  it('falls back to DEFAULT_UNICODE when override unicode is empty', () => {
    expect(resolveUnicode('PACKAGE', { PACKAGE: { unicode: '' } })).toBe(
      DEFAULT_UNICODE['PACKAGE'],
    );
  });

  it('returns "•" for an unknown key with no override', () => {
    expect(resolveUnicode('NOT_A_KEY')).toBe('•');
  });
});

describe('lineWithEmoji', () => {
  it('emits no entity when only a unicode fallback is configured', () => {
    const out = lineWithEmoji('PACKAGE', 'Subs');
    expect(out.text).toBe(`${DEFAULT_UNICODE['PACKAGE']} Subs`);
    expect(out.entities).toEqual([]);
  });

  it('emits a custom_emoji entity at offset 0 when tgEmojiId is configured', () => {
    const out = lineWithEmoji('PACKAGE', 'Subs', {
      PACKAGE: { unicode: '📦', tgEmojiId: '5234567890123456789' },
    });
    expect(out.text).toBe('📦 Subs');
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]).toMatchObject({
      type: 'custom_emoji',
      offset: 0,
      length: 2, // UTF-16 length of 📦
      custom_emoji_id: '5234567890123456789',
    });
  });

  it('skips the leading space when text already starts with a newline', () => {
    const out = lineWithEmoji('PACKAGE', '\nSubs');
    expect(out.text).toBe(`${DEFAULT_UNICODE['PACKAGE']}\nSubs`);
  });

  it('treats whitespace-only tgEmojiId as missing', () => {
    const out = lineWithEmoji('PACKAGE', 'Subs', {
      PACKAGE: { unicode: '📦', tgEmojiId: '   ' },
    });
    expect(out.entities).toEqual([]);
  });
});

describe('glyphLengthUtf16', () => {
  it('returns 0 for an empty string', () => {
    expect(glyphLengthUtf16('')).toBe(0);
  });

  it('counts a BMP glyph as 1 unit', () => {
    expect(glyphLengthUtf16('●')).toBe(1);
  });

  it('counts an astral emoji as 2 units', () => {
    expect(glyphLengthUtf16('🟢')).toBe(2);
  });

  it('counts a BMP glyph plus its VS16 selector as 2 units', () => {
    // '⚪️' is U+26AA U+FE0F: the selector belongs to the same rendered emoji.
    expect(glyphLengthUtf16('⚪️')).toBe(2);
  });
});

describe('lineWithEmojiAndDot', () => {
  const PREFIX = '📈 Трафик — '; // leading glyph + separator + copy
  const PREFIX_LENGTH = 12; // 2 (📈) + 1 (space) + 9 ('Трафик — ')

  it('emits no entities when neither slot has a premium id', () => {
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_OK', 'Трафик — ', ' 0%');
    expect(out.text).toBe('📈 Трафик — 🟢 0%');
    expect(out.entities).toEqual([]);
  });

  it('emits the leading slot glyph as an entity at offset 0', () => {
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_OK', 'Трафик — ', ' 0%', {
      SUB_TRAFFIC: { unicode: '📈', tgEmojiId: '5001' },
    });
    expect(out.text).toBe('📈 Трафик — 🟢 0%');
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5001' },
    ]);
  });

  it('places a BMP dot entity at its UTF-16 offset with length 1', () => {
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_OK', 'Трафик — ', ' 0%', {
      TRAFFIC_OK: { unicode: '●', tgEmojiId: '5002' },
    });
    expect(out.text).toBe('📈 Трафик — ● 0%');
    expect(out.text.indexOf('●')).toBe(PREFIX_LENGTH);
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: PREFIX_LENGTH, length: 1, custom_emoji_id: '5002' },
    ]);
  });

  it('places an astral dot entity at its UTF-16 offset with length 2', () => {
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_WARN', 'Трафик — ', ' 0%', {
      TRAFFIC_WARN: { unicode: '🟠', tgEmojiId: '5003' },
    });
    expect(out.text).toBe('📈 Трафик — 🟠 0%');
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: PREFIX_LENGTH, length: 2, custom_emoji_id: '5003' },
    ]);
  });

  it('covers a VS16 dot with its selector (length 2, not 1)', () => {
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_FULL', 'Трафик — ', ' 100%', {
      TRAFFIC_FULL: { unicode: '⚪\uFE0F', tgEmojiId: '5004' },
    });
    expect(out.text).toBe('📈 Трафик — ⚪\uFE0F 100%');
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: PREFIX_LENGTH, length: 2, custom_emoji_id: '5004' },
    ]);
  });

  it('emits both entities when the leading slot and the dot are premium', () => {
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_FULL', 'Трафик — ', ' 100%', {
      SUB_TRAFFIC: { unicode: '📈', tgEmojiId: '5001' },
      TRAFFIC_FULL: { unicode: '🔴', tgEmojiId: '5005' },
    });
    expect(out.text).toBe('📈 Трафик — 🔴 100%');
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5001' },
      { type: 'custom_emoji', offset: PREFIX_LENGTH, length: 2, custom_emoji_id: '5005' },
    ]);
  });

  it('keeps the dot glued to the copy when the copy starts with a newline', () => {
    // No separator is added when the first part itself starts a new line, so
    // the dot offset drops the space the other cases carry.
    const out = lineWithEmojiAndDot('SUB_TRAFFIC', 'TRAFFIC_OK', '\nТрафик — ', ' 0%', {
      TRAFFIC_OK: { unicode: '🟢', tgEmojiId: '5002' },
    });
    expect(out.text).toBe('📈\nТрафик — 🟢 0%');
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: utf16Length('📈\nТрафик — '), length: 2, custom_emoji_id: '5002' },
    ]);
  });
});

describe('resolvePlaceholders', () => {
  it('replaces {{KEY}} with the resolved unicode and emits an entity at the right offset', () => {
    const out = resolvePlaceholders('Welcome {{CARD}} to Rezeis', {
      CARD: { unicode: '💳', tgEmojiId: '5111' },
    });
    expect(out.text).toBe('Welcome 💳 to Rezeis');
    expect(out.entities).toHaveLength(1);
    // 'Welcome ' is 8 UTF-16 units.
    expect(out.entities[0]).toMatchObject({
      offset: 8,
      length: 2,
      custom_emoji_id: '5111',
    });
  });

  it('shifts entity offsets by baseOffset', () => {
    const out = resolvePlaceholders('{{CARD}}', { CARD: { unicode: '💳', tgEmojiId: '5111' } }, 100);
    expect(out.entities[0]?.offset).toBe(100);
  });

  it('walks multiple placeholders and accumulates correct UTF-16 offsets', () => {
    const out = resolvePlaceholders('{{PACKAGE}} subs {{CARD}} pay', {
      PACKAGE: { unicode: '📦', tgEmojiId: '5001' },
      CARD: { unicode: '💳', tgEmojiId: '5002' },
    });
    expect(out.text).toBe('📦 subs 💳 pay');
    expect(out.entities).toHaveLength(2);
    expect(out.entities[0]?.offset).toBe(0);
    // '📦' (2) + ' subs ' (6) = 8
    expect(out.entities[1]?.offset).toBe(8);
  });

  it('leaves the template unchanged when nothing matches', () => {
    const out = resolvePlaceholders('No placeholders here');
    expect(out.text).toBe('No placeholders here');
    expect(out.entities).toEqual([]);
  });
});

describe('joinLines', () => {
  it('concatenates lines with newlines', () => {
    const out = joinLines([
      { text: 'First', entities: [] },
      { text: 'Second', entities: [] },
    ]);
    expect(out.text).toBe('First\nSecond');
  });

  it('shifts entity offsets by the cumulative UTF-16 length of preceding lines + 1 per newline', () => {
    const out = joinLines([
      {
        text: '📦 line one',
        entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'a' }],
      },
      {
        text: '💳 line two',
        entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'b' }],
      },
    ]);
    expect(out.text).toBe('📦 line one\n💳 line two');
    expect(out.entities).toHaveLength(2);
    expect(out.entities[0]).toMatchObject({ offset: 0, custom_emoji_id: 'a' });
    // '📦 line one' is 2 + 9 = 11 UTF-16 units; + 1 for '\n' = 12.
    expect(out.entities[1]).toMatchObject({ offset: 12, custom_emoji_id: 'b' });
  });

  it('preserves entity order and other fields when merging', () => {
    const out = joinLines([
      {
        text: 'one',
        entities: [{ type: 'custom_emoji', offset: 0, length: 1, custom_emoji_id: 'x' }],
      },
    ]);
    expect(out.entities[0]).toEqual({
      type: 'custom_emoji',
      offset: 0,
      length: 1,
      custom_emoji_id: 'x',
    });
  });
});

describe('applyCustomEmojiTokens', () => {
  const map = {
    news_emoji_5: { id: '5333', fallback: '📰' },
    plain_glyph: { id: null, fallback: '🔥' },
    no_render: { id: null, fallback: null },
  };

  it('returns the input unchanged when no custom-emoji map is provided', () => {
    const out = applyCustomEmojiTokens(':news_emoji_5: hi', [], null);
    expect(out.text).toBe(':news_emoji_5: hi');
    expect(out.entities).toEqual([]);
  });

  it('replaces a :slug: token with its fallback glyph + a premium entity', () => {
    const out = applyCustomEmojiTokens(':news_emoji_5: Привет', [], map);
    expect(out.text).toBe('📰 Привет');
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5333' },
    ]);
  });

  it('renders the fallback glyph without an entity when no id is configured', () => {
    const out = applyCustomEmojiTokens('a :plain_glyph: b', [], map);
    expect(out.text).toBe('a 🔥 b');
    expect(out.entities).toEqual([]);
  });

  it('leaves unknown / unrenderable tokens untouched', () => {
    const out = applyCustomEmojiTokens(':unknown: :no_render:', [], map);
    expect(out.text).toBe(':unknown: :no_render:');
  });

  it('re-bases pre-existing entities after the replacement point', () => {
    // ":news_emoji_5:" is 14 UTF-16 units; "📰" is 2 → net -12 shift for
    // entities that sit after the token.
    const text = ':news_emoji_5: 👤';
    const profileOffset = utf16Length(':news_emoji_5: ');
    const existing = [
      { type: 'custom_emoji' as const, offset: profileOffset, length: 2, custom_emoji_id: '999' },
    ];
    const out = applyCustomEmojiTokens(text, existing, map);
    expect(out.text).toBe('📰 👤');
    const profile = out.entities.find((e) => e.custom_emoji_id === '999');
    expect(profile?.offset).toBe(utf16Length('📰 '));
    expect(out.entities.some((e) => e.custom_emoji_id === '5333')).toBe(true);
  });
})

describe('stripCustomEmojiEntities', () => {
  it('drops only custom_emoji entities, keeping text-format ones intact', () => {
    // The second entity is deliberately NOT a custom_emoji — that is what the
    // function has to keep — so the array cannot satisfy the parameter type
    // element-wise. Cast the array, not the element, so the shapes stay honest.
    const entities = [
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5333' },
      { type: 'bold', offset: 3, length: 4 },
    ] as unknown as Parameters<typeof stripCustomEmojiEntities>[0];
    const out = stripCustomEmojiEntities(entities);
    expect(out).toEqual([{ type: 'bold', offset: 3, length: 4 }]);
  });

  it('returns an empty array when given an empty array', () => {
    expect(stripCustomEmojiEntities([])).toEqual([]);
  });
})

describe('renderBotCopy owner-premium awareness', () => {
  const botEmojis = { CARD: { unicode: '💳', tgEmojiId: '12345' } };
  const customEmojis = { news_emoji_5: { id: '5333', fallback: '📰' } };

  it('keeps custom_emoji entities when the owner has premium (default)', () => {
    const out = renderBotCopy('{{CARD}} :news_emoji_5: hi', botEmojis, customEmojis);
    expect(out.text).toBe('💳 📰 hi');
    expect(out.entities.some((e) => e.type === 'custom_emoji')).toBe(true);
    expect(out.entities.length).toBe(2);
  });

  it('strips custom_emoji entities when the owner has no premium (fallback glyphs stay as text)', () => {
    const out = renderBotCopy('{{CARD}} :news_emoji_5: hi', botEmojis, customEmojis, false);
    // Text (fallback glyphs) is unchanged — only the premium entities are gone.
    expect(out.text).toBe('💳 📰 hi');
    expect(out.entities.every((e) => e.type !== 'custom_emoji')).toBe(true);
  });
})
