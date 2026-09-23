import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { formatUptime, notifyOperatorBotStopped } from '../../../src/bot/lib/startup-notice.js';
import { REIWA_VERSION } from '../../../src/core/version.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildPassthroughTranslator,
  operatorEmojiConfig,
  withOperatorText,
} from '../pages/helpers.js';

/**
 * The bot-stopped operator card.
 *
 * Two things here are easy to get wrong in a way nobody notices until it
 * matters:
 *
 *   • The card must carry NO buttons. It is sent after the polling loop has
 *     already been stopped — deliberately, so a slow send cannot delay
 *     releasing Telegram's polling slot — which means no callback query can
 *     ever be answered. A Close button copied over from the startup card would
 *     look right and do nothing.
 *   • Uptime is the field an operator reads to tell a deploy from a restart
 *     loop, so "2 seconds" and "2 hours" have to be distinguishable at a
 *     glance, and a bot that lived under a second still has to report a number.
 *
 * The translator double echoes its key, as in `startup-credits.test.ts`, so the
 * assertions name translation keys instead of Russian copy — copy changes are
 * not regressions, choosing the wrong key is.
 */

const translator = { t: (key: string) => key } as never;

describe('formatUptime', () => {
  it('reports at most two units, largest first', () => {
    expect(formatUptime(90_000, translator, 'ru')).toBe('1bot_event.unit.m 30bot_event.unit.s');
    expect(formatUptime(3_661_000, translator, 'ru')).toBe('1bot_event.unit.h 1bot_event.unit.m');
    // A day and an hour: the minutes and seconds are dropped, not summed into
    // the hour.
    expect(formatUptime(90_000_000, translator, 'ru')).toBe('1bot_event.unit.d 1bot_event.unit.h');
  });

  it('drops a trailing zero unit instead of printing it', () => {
    // Exactly one hour. `1ч 0м` is noise, and worse, it reads as a rounded
    // value rather than an exact one.
    expect(formatUptime(3_600_000, translator, 'ru')).toBe('1bot_event.unit.h');
    expect(formatUptime(45_000, translator, 'ru')).toBe('45bot_event.unit.s');
  });

  it('still reports a number for a process that barely lived', () => {
    // The interesting case: a crash-loop restarts in well under a second, and
    // an empty string here would read as a missing field rather than as the
    // strongest possible signal that something is wrong.
    expect(formatUptime(0, translator, 'ru')).toBe('0bot_event.unit.s');
    expect(formatUptime(400, translator, 'ru')).toBe('0bot_event.unit.s');
  });

  it('never renders a negative duration', () => {
    // Clocks move backwards (NTP steps, container suspend). `-3с` would be a
    // more alarming thing to read than the truth.
    expect(formatUptime(-5_000, translator, 'ru')).toBe('0bot_event.unit.s');
  });
});

describe('notifyOperatorBotStopped', () => {
  function fakeBot() {
    const sendMessage = vi.fn(async () => undefined);
    return { bot: { api: { sendMessage } } as never, sendMessage };
  }

  it('reports the signal, the uptime and the version that left', async () => {
    const { bot, sendMessage } = fakeBot();
    await notifyOperatorBotStopped({
      bot,
      devId: 42,
      translator,
      logger: undefined as never,
      signal: 'SIGTERM',
      uptimeMs: 7_400_000,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, text, other] = sendMessage.mock.calls[0] as unknown as [
      number,
      string,
      unknown,
    ];
    expect(chatId).toBe(42);
    expect(text).toContain('#EventBotStopped');
    expect(text).toContain('SIGTERM');
    expect(text).toContain('2bot_event.unit.h 3bot_event.unit.m');
    expect(text).toContain(`v${REIWA_VERSION}`);
    // No options object at all — which is also how the "no buttons" rule is
    // enforced below.
    expect(other).toBeUndefined();
  });

  it('carries no buttons, because nothing is left to answer them', async () => {
    const { bot, sendMessage } = fakeBot();
    await notifyOperatorBotStopped({
      bot,
      devId: 42,
      translator,
      logger: undefined as never,
      signal: 'SIGINT',
      uptimeMs: 1_000,
    });

    const call = sendMessage.mock.calls[0] as unknown as [number, string, unknown?];
    expect(JSON.stringify(call[2] ?? {})).not.toContain('reply_markup');
  });

  it('says nothing when no developer id is configured', async () => {
    const { bot, sendMessage } = fakeBot();
    await notifyOperatorBotStopped({
      bot,
      devId: undefined,
      translator,
      logger: undefined as never,
      signal: 'SIGTERM',
      uptimeMs: 1_000,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('swallows a send failure rather than failing the shutdown', async () => {
    // Telegram being unreachable is one of the likelier reasons a bot is being
    // stopped in the first place. Throwing here would take the exit path with
    // it — and the caller is running against Docker's SIGKILL timer.
    const sendMessage = vi.fn(async () => {
      throw new Error('network down');
    });
    const warn = vi.fn();

    await expect(
      notifyOperatorBotStopped({
        bot: { api: { sendMessage } } as never,
        devId: 42,
        translator,
        logger: { warn } as never,
        signal: 'SIGTERM',
        uptimeMs: 1_000,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });

  // The card's words are translator keys «Тексты бота» can override, with the
  // panel's emoji picker in the field. Sent raw, the operator read `:fire:`.
  it('carries the operator text, emoji tokens resolved', async () => {
    const { bot, sendMessage } = fakeBot();
    await notifyOperatorBotStopped({
      bot,
      devId: 42,
      translator: withOperatorText(buildPassthroughTranslator(), ['bot_event.stopped']),
      logger: undefined as never,
      signal: 'SIGTERM',
      uptimeMs: 1_000,
      getConfig: async () => operatorEmojiConfig(),
    });

    const [, text, other] = sendMessage.mock.calls[0] as unknown as [number, string, { entities?: unknown }];
    const head = '#EventBotStopped\n\n';
    expect(text.startsWith(`${head}${OPERATOR_TEXT_GLYPHS}\n\n`)).toBe(true);
    expect(other.entities).toEqual([{ ...FIRE_ENTITY, offset: head.length }]);
  });

  // `main.ts` cannot be imported by a spec (it boots the bot), so the one call
  // is pinned by source: without the config the words keep their tokens.
  it('is handed the bot config by main.ts', () => {
    const main = readFileSync(resolve(__dirname, '../../../src/bot/main.ts'), 'utf8');
    const call = main.slice(main.indexOf('notifyOperatorBotStopped({'));
    expect(call.slice(0, call.indexOf('})'))).toContain('getConfig: pageDeps.getConfig');
  });

  it('does not wait on a config that does not answer: the farewell has four seconds', async () => {
    // Read from the panel when the cache has gone stale, and the process is
    // leaving. The card goes out with its tokens as typed rather than not at all.
    vi.useFakeTimers();
    try {
      const { bot, sendMessage } = fakeBot();
      const sent = notifyOperatorBotStopped({
        bot,
        devId: 42,
        translator,
        logger: undefined as never,
        signal: 'SIGTERM',
        uptimeMs: 1_000,
        getConfig: () => new Promise(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await sent;
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
