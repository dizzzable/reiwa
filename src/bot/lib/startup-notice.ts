/**
 * Bot-started operator notice.
 *
 * On startup the bot pings the operator (BOT_DEV_ID) with an "#EventBotStarted"
 * card showing the current platform access mode + a "Close" button — mirroring
 * the snoups/remnashop behaviour. Best-effort: any failure (no dev id, send
 * error) is logged and swallowed so it never blocks the bot.
 */
import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';

import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import type { AdminClient } from '../../lib/admin-client.js';
import type { BotContext, PageDeps } from '../pages/types.js';

export async function notifyOperatorBotStarted(opts: {
  readonly bot: Bot<BotContext>;
  readonly devId: number | undefined;
  readonly adminClient: AdminClient | null;
  readonly translator: PageDeps['translator'];
  readonly logger: PageDeps['logger'];
}): Promise<void> {
  const { bot, devId, adminClient, translator, logger } = opts;
  if (devId === undefined) return;

  // Operator-facing notice — render in Russian (the panel's primary locale).
  const lang = 'ru';
  let modeKey = 'PUBLIC';
  try {
    if (adminClient !== null) {
      const policy = await getPolicyCache(adminClient).get();
      modeKey = policy.accessMode;
    }
  } catch {
    /* policy unavailable — fall back to PUBLIC label */
  }

  const title = translator.t('bot_event.started', lang);
  const accessLabel = translator.t('bot_event.access_mode', lang);
  const modeValue = translator.t(`bot_event.mode.${modeKey}`, lang);
  const text = `#EventBotStarted\n\n${title}\n\n• ${accessLabel}: ${modeValue}`;
  const keyboard = new InlineKeyboard().text(translator.t('bot_event.close', lang), 'close');

  try {
    await bot.api.sendMessage(devId, text, { reply_markup: keyboard });
  } catch (err: unknown) {
    logger?.warn({ err, devId }, 'bot/startup: operator notice send failed');
  }
}
