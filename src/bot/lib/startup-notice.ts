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
import { REIWA_VERSION } from '../../core/version.js';
import type { AdminClient } from '../../lib/admin-client.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import type { BotContext, PageDeps } from '../pages/types.js';

/**
 * Developer-credits card links + crypto wallets. These point at the open-core
 * project (REIWA) author so the operator/developer can reach the source,
 * community, and support channels from the startup card.
 *
 * The project name on this card is ALWAYS "REIWA" by design — forks may
 * re-brand everything else, but this attribution card stays fixed.
 */
const CREDITS_PROJECT_NAME = 'REIWA';
const CREDITS_GITHUB_URL = 'https://github.com/dizzzable/reiwa';
const CREDITS_TELEGRAM_URL = 'https://t.me/rezies_reiwa';
const CREDITS_SUPPORT_URL = 'https://www.donationalerts.com/r/dizzzable';
const CREDITS_WALLET_USDT_TRC20 = 'TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR';
const CREDITS_WALLET_TRX = 'TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR';
const CREDITS_WALLET_BNB = '0x22b74b0c2606d3f49bdd144cdfbf6f070750c2ff';

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

/**
 * Developer-only credits card (snoups/remnashop-style). Sent on startup to the
 * configured BOT_DEV_ID alongside the access-mode notice. Shows the fixed
 * project name (REIWA) + running version, an open-core attribution line, the
 * crypto wallets (tap-to-copy via HTML <code>), and link buttons (GitHub +
 * Telegram on one row / Support) plus a Close button. Best-effort: any failure
 * (no dev id, send error) is logged and swallowed.
 */
export async function notifyDeveloperCredits(opts: {
  readonly bot: Bot<BotContext>;
  readonly devId: number | undefined;
  readonly translator: PageDeps['translator'];
  readonly logger: PageDeps['logger'];
}): Promise<void> {
  const { bot, devId, translator, logger } = opts;
  if (devId === undefined) return;

  const lang = 'ru';

  const heading = `${CREDITS_PROJECT_NAME} v${REIWA_VERSION}`;
  const intro = translator.t('bot_event.credits.intro', lang);
  const callToAction = translator.t('bot_event.credits.call_to_action', lang);
  const walletsTitle = translator.t('bot_event.credits.wallets_title', lang);

  // HTML parse mode so the wallet addresses render as tap-to-copy <code>.
  const text = [
    '#EventBotCredits',
    '',
    `<b>${heading}</b>`,
    '',
    intro,
    '',
    callToAction,
    '',
    walletsTitle,
    `USDT (TRC-20): <code>${CREDITS_WALLET_USDT_TRC20}</code>`,
    `TRX: <code>${CREDITS_WALLET_TRX}</code>`,
    `BNB: <code>${CREDITS_WALLET_BNB}</code>`,
  ].join('\n');

  const keyboard = new InlineKeyboard();
  // GitHub + Telegram share one row.
  if (isTelegramSafeButtonUrl(CREDITS_GITHUB_URL)) {
    keyboard.url(translator.t('bot_event.credits.github', lang), CREDITS_GITHUB_URL);
  }
  if (isTelegramSafeButtonUrl(CREDITS_TELEGRAM_URL)) {
    keyboard.url(translator.t('bot_event.credits.telegram', lang), CREDITS_TELEGRAM_URL);
  }
  keyboard.row();
  if (isTelegramSafeButtonUrl(CREDITS_SUPPORT_URL)) {
    keyboard.url(translator.t('bot_event.credits.support', lang), CREDITS_SUPPORT_URL).row();
  }
  keyboard.text(translator.t('bot_event.close', lang), 'close');

  try {
    await bot.api.sendMessage(devId, text, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err: unknown) {
    logger?.warn({ err, devId }, 'bot/startup: developer credits send failed');
  }
}
