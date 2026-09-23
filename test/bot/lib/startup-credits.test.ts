/**
 * The developer-credits card's link buttons.
 *
 * Worth pinning because of how this card fails. Every URL goes through
 * `isTelegramSafeButtonUrl` and a button whose URL does not pass is simply not
 * added — no throw, no log, nothing in the card to notice. A typo, an `http://`
 * slip, or a value that arrives empty therefore does not break the card: it
 * removes a button, and the next person to look at a screenshot has to
 * remember that a button used to be there.
 *
 * So these assert the addresses themselves rather than "a support button
 * exists": the point of the button is where it goes.
 */
import { describe, expect, it, vi } from 'vitest';

import { notifyDeveloperCredits, notifyOperatorBotStarted } from '../../../src/bot/lib/startup-notice.js';
import {
  FIRE_EMOJI_ID,
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildPassthroughTranslator,
  operatorEmojiConfig,
  withOperatorText,
} from '../pages/helpers.js';

interface CapturedButton {
  readonly text: string;
  readonly url?: string;
  readonly callback_data?: string;
}

/**
 * Drives the real function against a bot double and returns the flattened
 * keyboard. `translator.t` echoes its key so a button can be identified by the
 * translation key it uses — the visible label is free to change without
 * rewriting this suite, and a renamed key fails loudly instead of matching a
 * stale Russian string.
 */
async function renderCredits(): Promise<{
  buttons: CapturedButton[];
  text: string;
}> {
  let sentText = '';
  let markup: { inline_keyboard: CapturedButton[][] } | undefined;

  const bot = {
    api: {
      sendMessage: vi.fn(
        async (
          _chatId: number,
          text: string,
          other: { reply_markup: { inline_keyboard: CapturedButton[][] } },
        ) => {
          sentText = text;
          markup = other.reply_markup;
        },
      ),
    },
  };

  await notifyDeveloperCredits({
    bot: bot as never,
    devId: 42,
    translator: { t: (key: string) => key } as never,
    logger: undefined as never,
  });

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  return { buttons: (markup?.inline_keyboard ?? []).flat(), text: sentText };
}

describe('developer credits card', () => {
  it('points the support button at the current donation link', async () => {
    const { buttons } = await renderCredits();
    const support = buttons.find((b) => b.text === 'bot_event.credits.support');

    // Present at all: `isTelegramSafeButtonUrl` drops a rejected URL silently,
    // so this assertion is the only thing between a bad edit and a card that
    // quietly stops asking for support.
    expect(support, 'the support button must be rendered').toBeDefined();
    expect(support?.url).toBe('https://dalink.to/dizzzable');
  });

  it('renders every link button, so none was dropped by the safety gate', async () => {
    const { buttons } = await renderCredits();
    const byKey = Object.fromEntries(buttons.map((b) => [b.text, b.url]));

    expect(byKey).toMatchObject({
      'bot_event.credits.github': 'https://github.com/dizzzable/reiwa',
      'bot_event.credits.telegram': 'https://t.me/rezies_reiwa',
      'bot_event.credits.support': 'https://dalink.to/dizzzable',
    });
    // The Close button is a callback, not a URL — asserted separately so the
    // check above cannot pass by finding three buttons of the wrong kind.
    expect(buttons.find((b) => b.text === 'bot_event.close')?.callback_data).toBe('close');
  });

  it('keeps every button URL on https, which is what the gate requires', async () => {
    const { buttons } = await renderCredits();
    const urls = buttons.filter((b) => b.url !== undefined).map((b) => b.url!);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('https://'), `${url} must be https`).toBe(true);
    }
  });

  it('still names the project REIWA regardless of branding elsewhere', async () => {
    // The attribution line is fixed by design — a fork may re-brand everything
    // else, and this card is the one place that must not follow.
    const { text } = await renderCredits();
    expect(text).toContain('#EventBotCredits');
    expect(text).toContain('REIWA v');
  });
});

// The cards' texts are translator keys «Тексты бота» can override, with the
// panel's emoji picker in the field. Their buttons already resolved the tokens;
// the texts did not, so the operator read `:fire:` on their own cards.
describe('operator cards carry the operator text, emoji tokens resolved', () => {
  function capture() {
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _other?: Record<string, unknown>) => undefined);
    return { bot: { api: { sendMessage } } as never, sendMessage };
  }

  it('the startup card: the pack emoji’s entity where the edited line sits', async () => {
    const { bot, sendMessage } = capture();
    await notifyOperatorBotStarted({
      bot,
      devId: 42,
      adminClient: null,
      translator: withOperatorText(buildPassthroughTranslator(), ['bot_event.started']),
      logger: undefined as never,
      getConfig: async () => operatorEmojiConfig(),
    });

    const [, text, other] = sendMessage.mock.calls[0]!;
    const head = '#EventBotStarted\n\n';
    expect(text.startsWith(`${head}${OPERATOR_TEXT_GLYPHS}\n\n`)).toBe(true);
    expect(other?.entities).toEqual([{ ...FIRE_ENTITY, offset: head.length }]);
  });

  it('the credits card, sent as HTML: the pack emoji as a <tg-emoji> tag', async () => {
    const { bot, sendMessage } = capture();
    await notifyDeveloperCredits({
      bot,
      devId: 42,
      translator: withOperatorText(buildPassthroughTranslator(), [
        'bot_event.credits.intro',
        'bot_event.credits.call_to_action',
        'bot_event.credits.wallets_title',
      ]),
      logger: undefined as never,
      getConfig: async () => operatorEmojiConfig(),
    });

    const [, text, other] = sendMessage.mock.calls[0]!;
    const resolved = `<tg-emoji emoji-id="${FIRE_EMOJI_ID}">🔥</tg-emoji> Здравствуйте! 🎁`;
    expect(text.split(resolved)).toHaveLength(4);
    expect(text).not.toContain(':fire:');
    expect(other).toMatchObject({ parse_mode: 'HTML' });
  });
});
