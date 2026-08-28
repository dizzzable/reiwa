import { describe, expect, it, vi } from 'vitest';

import { formatUptime, notifyOperatorBotStopped } from '../../../src/bot/lib/startup-notice.js';
import { REIWA_VERSION } from '../../../src/core/version.js';

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
});
