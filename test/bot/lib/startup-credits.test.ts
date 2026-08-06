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

import { notifyDeveloperCredits } from '../../../src/bot/lib/startup-notice';

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
