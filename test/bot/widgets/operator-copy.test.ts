/**
 * `markdownV2Copy` — the operator's emoji tokens in a MarkdownV2 text, the
 * markup around them left exactly as written.
 *
 * The listener spec (`internal-notify-emoji.test.ts`) drives it end to end;
 * these pin the scanner's edges, each of which, got wrong, either breaks the
 * operator's formatting or makes Telegram refuse the message.
 */
import { describe, expect, it } from 'vitest';

import { htmlCopy, markdownV2Copy, messageCopy } from '../../../src/bot/widgets/operator-copy.js';

const FIRE_ID = '5368324170671202286';
const GIFT_ID = '5203996991054432397';

const emojis = {
  botEmojis: { GIFT: { unicode: '🎁', tgEmojiId: GIFT_ID }, STATUS_ACTIVE: { unicode: '🟢' } },
  customEmojis: {
    fire: { id: FIRE_ID, fallback: '🔥' },
    odd_id: { id: 'not-a-number', fallback: '✨' },
    id_only: { id: FIRE_ID, fallback: null },
  },
  botEmojiOwnerHasPremium: true,
};

describe('markdownV2Copy', () => {
  it('writes a slot with a premium id in MarkdownV2’s custom-emoji syntax, in either spelling', () => {
    expect(markdownV2Copy('{{GIFT}} и \\{\\{GIFT\\}\\}', emojis)).toBe(
      `![🎁](tg://emoji?id=${GIFT_ID}) и ![🎁](tg://emoji?id=${GIFT_ID})`,
    );
  });

  it('reads an escaped underscore in a slot’s name', () => {
    expect(markdownV2Copy('\\{\\{STATUS\\_ACTIVE\\}\\}', emojis)).toBe('🟢');
  });

  it('gives a pack emoji with no fallback the star Telegram needs to host it', () => {
    expect(markdownV2Copy(':id_only:', emojis)).toBe(`![⭐](tg://emoji?id=${FIRE_ID})`);
  });

  it('keeps a glyph alone when the id is not a number Telegram takes', () => {
    expect(markdownV2Copy(':odd_id:', emojis)).toBe('✨');
  });

  it('leaves an unknown slug as written, in whichever spelling it came', () => {
    expect(markdownV2Copy('12:30:45 и :no\\_such:', emojis)).toBe('12:30:45 и :no\\_such:');
  });

  it('does not take an escaped backtick for the start of code', () => {
    // Were `\`` a backtick, it would open a code span that the one before «код»
    // closes, and the emoji between them would stay a token.
    expect(markdownV2Copy('\\`:fire: `код`', emojis)).toBe(`\\\`![🔥](tg://emoji?id=${FIRE_ID}) \`код\``);
  });

  it('leaves a link’s target alone, and its text is ordinary text', () => {
    expect(markdownV2Copy('[:fire: сайт](https://example.com/a:fire:b)', emojis)).toBe(
      `[![🔥](tg://emoji?id=${FIRE_ID}) сайт](https://example.com/a:fire:b)`,
    );
  });

  it('writes glyphs, escaped, for an owner without Premium', () => {
    expect(markdownV2Copy(':fire: {{GIFT}}', { ...emojis, botEmojiOwnerHasPremium: false })).toBe('🔥 🎁');
  });
});

/**
 * `messageCopy` / `htmlCopy` and the owner's Premium. Telegram refuses a bot
 * message that carries custom emoji — as entities or as `<tg-emoji>` — when the
 * bot's owner has no Premium, so for such an owner every pack emoji and slot
 * goes out as its glyph. Some thirty send paths render through these two, and
 * every page fixture is a Premium owner's: nothing else pins it.
 */
describe('messageCopy and htmlCopy — the owner’s Premium', () => {
  const text = ':fire: и {{GIFT}}';
  const FIRE = { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE_ID };
  const GIFT = { type: 'custom_emoji', offset: 5, length: 2, custom_emoji_id: GIFT_ID };
  const TAGGED = `<tg-emoji emoji-id="${FIRE_ID}">🔥</tg-emoji> и <tg-emoji emoji-id="${GIFT_ID}">🎁</tg-emoji>`;

  it('carry the premium emoji for an owner with Premium', () => {
    expect(messageCopy(text, emojis)).toEqual({ text: '🔥 и 🎁', entities: [FIRE, GIFT] });
    expect(htmlCopy(text, emojis)).toBe(TAGGED);
  });

  it('carry no custom emoji for an owner without Premium: glyphs only', () => {
    const withoutPremium = { ...emojis, botEmojiOwnerHasPremium: false };
    expect(messageCopy(text, withoutPremium)).toEqual({ text: '🔥 и 🎁', entities: [] });
    expect(htmlCopy(text, withoutPremium)).toBe('🔥 и 🎁');
  });

  // `BotConfig.botEmojiOwnerHasPremium`: absent means true. It is also what the
  // renderers these two wrap default to, so a text renders the same here as on
  // a page that calls those directly with the flag as the config has it.
  it('read an unset flag as Premium, as the config contract says', () => {
    const unset = { botEmojis: emojis.botEmojis, customEmojis: emojis.customEmojis };
    expect(messageCopy(text, unset)).toEqual({ text: '🔥 и 🎁', entities: [FIRE, GIFT] });
    expect(htmlCopy(text, unset)).toBe(TAGGED);
  });
});
