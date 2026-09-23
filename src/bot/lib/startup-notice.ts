/**
 * Bot lifecycle notices for the operator (BOT_DEV_ID).
 *
 * On startup the bot pings the operator (BOT_DEV_ID) with an "#EventBotStarted"
 * card showing the current platform access mode + a "Close" button — mirroring
 * the snoups/remnashop behaviour. Best-effort: any failure (no dev id, send
 * error) is logged and swallowed so it never blocks the bot.
 */
import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';

import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import { REIWA_VERSION } from '../../core/version.js';
import type { AdminClient } from '../../lib/admin-client.js';
import { renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { htmlCopy, messageCopy } from '../widgets/operator-copy.js';
import type { BotContext, PageDeps } from '../pages/types.js';

/**
 * The operator can rewrite every label on these cards through the panel's text
 * editor (they are ordinary i18n keys, so `translations` overrides them), which
 * means they can carry `:slug:` pack tokens and `{{KEY}}` placeholders just like
 * any other button copy. These are plain link/callback buttons with no
 * per-button icon slot in the panel, so `renderButtonLabel` is the right
 * renderer — not `renderSystemButton`.
 *
 * `botCfg` is optional because the cards are best-effort startup pings: a
 * missing config must never keep them from being sent. With no config there is
 * nothing to substitute, and the label is passed through unchanged.
 */
function cardButton(
  label: string,
  botCfg: BotConfig | null,
): { text: string } | { text: string; icon_custom_emoji_id: string } {
  if (botCfg === null) return { text: label };
  const rendered = renderButtonLabel(
    label,
    botCfg.botEmojis,
    botCfg.customEmojis,
    botCfg.botEmojiOwnerHasPremium ?? true,
  );
  return rendered.iconCustomEmojiId !== undefined
    ? { text: rendered.text, icon_custom_emoji_id: rendered.iconCustomEmojiId }
    : { text: rendered.text };
}

/**
 * Best-effort config read — a failure degrades the labels, never the card.
 * `budgetMs` bounds it: a cache gone stale reads from the panel, and a card
 * sent against a deadline goes out with its tokens as typed instead.
 */
async function loadCardConfig(
  getConfig: (() => Promise<BotConfig>) | undefined,
  budgetMs?: number,
): Promise<BotConfig | null> {
  if (getConfig === undefined) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = getConfig();
    if (budgetMs === undefined) return await read;
    return await Promise.race([
      read,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
const CREDITS_SUPPORT_URL = 'https://dalink.to/dizzzable';
const CREDITS_WALLET_USDT_TRC20 = 'TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR';
const CREDITS_WALLET_TRX = 'TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR';
const CREDITS_WALLET_BNB = '0x22b74b0c2606d3f49bdd144cdfbf6f070750c2ff';

/**
 * How long the bot-stopped card waits for the config its words are rendered
 * with: a quarter of the four seconds the shutdown gives the whole farewell.
 */
const STOPPED_CARD_CONFIG_BUDGET_MS = 1_000;

export async function notifyOperatorBotStarted(opts: {
  readonly bot: Bot<BotContext>;
  readonly devId: number | undefined;
  readonly adminClient: AdminClient | null;
  readonly translator: PageDeps['translator'];
  readonly logger: PageDeps['logger'];
  /** Bot config source for resolving operator emoji tokens on the button. */
  readonly getConfig?: PageDeps['getConfig'];
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
  const botCfg = await loadCardConfig(opts.getConfig);
  // The words are operator copy like the button's: their emoji tokens resolved.
  const card = messageCopy(`#EventBotStarted\n\n${title}\n\n• ${accessLabel}: ${modeValue}`, botCfg);
  const keyboard = new InlineKeyboard().text(
    cardButton(translator.t('bot_event.close', lang), botCfg),
    'close',
  );

  try {
    await bot.api.sendMessage(devId, card.text, {
      reply_markup: keyboard,
      entities: card.entities.length > 0 ? card.entities : undefined,
    });
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
  /** Bot config source for resolving operator emoji tokens on the buttons. */
  readonly getConfig?: PageDeps['getConfig'];
}): Promise<void> {
  const { bot, devId, translator, logger } = opts;
  if (devId === undefined) return;

  const lang = 'ru';

  const heading = `${CREDITS_PROJECT_NAME} v${REIWA_VERSION}`;
  const botCfg = await loadCardConfig(opts.getConfig);
  // Operator copy inside an HTML message, which cannot also carry entities: a
  // premium emoji as a `<tg-emoji>` tag, the markup around it untouched.
  const intro = htmlCopy(translator.t('bot_event.credits.intro', lang), botCfg);
  const callToAction = htmlCopy(translator.t('bot_event.credits.call_to_action', lang), botCfg);
  const walletsTitle = htmlCopy(translator.t('bot_event.credits.wallets_title', lang), botCfg);

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
    keyboard.url(cardButton(translator.t('bot_event.credits.github', lang), botCfg), CREDITS_GITHUB_URL);
  }
  if (isTelegramSafeButtonUrl(CREDITS_TELEGRAM_URL)) {
    keyboard.url(cardButton(translator.t('bot_event.credits.telegram', lang), botCfg), CREDITS_TELEGRAM_URL);
  }
  keyboard.row();
  if (isTelegramSafeButtonUrl(CREDITS_SUPPORT_URL)) {
    keyboard.url(cardButton(translator.t('bot_event.credits.support', lang), botCfg), CREDITS_SUPPORT_URL).row();
  }
  keyboard.text(cardButton(translator.t('bot_event.close', lang), botCfg), 'close');

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

/**
 * Compact uptime, at most two units, largest first: `3д 4ч`, `12м 7с`, `41с`.
 *
 * Exported so it can be tested on its own. The unit suffixes come from the
 * translator rather than being written into this function, because they are
 * words — an operator running the panel in English should not read `4ч`.
 */
export function formatUptime(
  uptimeMs: number,
  translator: PageDeps['translator'],
  lang: SupportedLocale,
): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const parts: ReadonlyArray<readonly [number, string]> = [
    [Math.floor(totalSeconds / 86_400), 'd'],
    [Math.floor((totalSeconds % 86_400) / 3_600), 'h'],
    [Math.floor((totalSeconds % 3_600) / 60), 'm'],
    [totalSeconds % 60, 's'],
  ];
  const render = ([value, unit]: readonly [number, string]): string =>
    `${value}${translator.t(`bot_event.unit.${unit}`, lang)}`;

  const firstIndex = parts.findIndex(([value]) => value > 0);
  // A bot that lived less than a second still ran; `0с` says so, an empty
  // string would read as a missing field.
  if (firstIndex === -1) return render(parts[parts.length - 1] as readonly [number, string]);

  const head = parts[firstIndex] as readonly [number, string];
  const next = parts[firstIndex + 1];
  return next !== undefined && next[0] > 0 ? `${render(head)} ${render(next)}` : render(head);
}

/**
 * Bot-stopped operator notice — the mirror of {@link notifyOperatorBotStarted},
 * sent from the SIGTERM/SIGINT path in `bot/lib/shutdown.ts`.
 *
 * Carries the signal, how long the process lived and which version just left,
 * which together answer the question a farewell is actually useful for: was
 * this a deploy, or is something restarting the container in a loop.
 *
 * NO BUTTONS, unlike the startup card. By the time this is sent the polling
 * loop has already been stopped — that ordering is deliberate, see
 * `shutdown.ts` — so nothing is left to receive a callback query. A Close
 * button here would be a control that visibly does nothing.
 *
 * Best-effort in the same way as its sibling: any failure is logged and
 * swallowed. It is also bounded by the caller, because the process is running
 * against Docker's SIGKILL timer while this is in flight — which is why the
 * config its words are rendered with gets {@link STOPPED_CARD_CONFIG_BUDGET_MS}
 * of the four seconds, and no more.
 */
export async function notifyOperatorBotStopped(opts: {
  readonly bot: Bot<BotContext>;
  readonly devId: number | undefined;
  readonly translator: PageDeps['translator'];
  readonly logger: PageDeps['logger'];
  readonly signal: string;
  readonly uptimeMs: number;
  /** Bot config source for resolving operator emoji tokens in the words. */
  readonly getConfig?: PageDeps['getConfig'];
}): Promise<void> {
  const { bot, devId, translator, logger, signal, uptimeMs } = opts;
  if (devId === undefined) return;

  // Operator-facing notice — Russian, exactly as the startup card.
  const lang = 'ru';
  const title = translator.t('bot_event.stopped', lang);
  const signalLabel = translator.t('bot_event.stopped.signal', lang);
  const uptimeLabel = translator.t('bot_event.stopped.uptime', lang);
  const versionLabel = translator.t('bot_event.stopped.version', lang);

  const text = [
    '#EventBotStopped',
    '',
    title,
    '',
    `• ${signalLabel}: ${signal}`,
    `• ${uptimeLabel}: ${formatUptime(uptimeMs, translator, lang)}`,
    `• ${versionLabel}: v${REIWA_VERSION}`,
  ].join('\n');
  // Operator copy, like the startup card's: its emoji tokens resolved.
  const card = messageCopy(text, await loadCardConfig(opts.getConfig, STOPPED_CARD_CONFIG_BUDGET_MS));

  try {
    // Still no options object without entities: no buttons, see above.
    await bot.api.sendMessage(
      devId,
      card.text,
      card.entities.length > 0 ? { entities: card.entities } : undefined,
    );
  } catch (err: unknown) {
    logger?.warn({ err, devId }, 'bot/shutdown: operator notice send failed');
  }
}
