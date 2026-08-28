/**
 * Central bot error handler (`bot.catch`)
 * ───────────────────────────────────────
 * One chokepoint for every error thrown by a grammy handler. Mirrors the
 * snoups/remnashop `ErrorMiddleware` contract: branch on the error's nature
 * instead of treating everything as a crash.
 *
 *   1. `GrammyError` 403  → the user blocked the bot / chat is gone. Nothing
 *      to deliver and not a bug — swallow quietly.
 *   2. `DomainError` (userFacing) → an expected business outcome. Show the
 *      user a friendly message + support button; do NOT page the dev firehose.
 *   3. everything else (incl. non-userFacing DomainError, UpstreamError,
 *      programming errors) → log, report to the dev firehose, and apologise
 *      to the user with a generic message + support button.
 *
 * All user-facing delivery is best-effort: a failure to notify never
 * re-enters the handler.
 */
import { GrammyError, InlineKeyboard } from 'grammy';
import type { BotError } from 'grammy';

import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import { DomainError } from '../../core/errors/index.js';
import type { ErrorReporter } from '../../infrastructure/error-reporter/index.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import { renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import { coerceLocale } from '../pages/coerce-locale.js';
import { resolveSupportDeepLink } from '../widgets/main-keyboard.js';
import type { BotContext, UserLocaleSyncCache } from '../pages/types.js';

export interface BotErrorHandlerDeps {
  readonly logger: LoggerPort;
  readonly errorReporter: ErrorReporter;
  readonly translator: TranslatorPort;
  readonly userLocale: UserLocaleSyncCache;
  readonly getConfig: () => Promise<BotConfig>;
  /** `BOT_SUPPORT_USERNAME` env fallback when the admin handle is unset. */
  readonly envSupportUsername?: string;
}

export function createBotErrorHandler(
  deps: BotErrorHandlerDeps,
): (err: BotError<BotContext>) => Promise<void> {
  return async (err: BotError<BotContext>): Promise<void> => {
    const ctx = err.ctx;
    const cause: unknown = err.error;
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));

    // 1) User blocked the bot / chat unavailable — not a crash.
    if (cause instanceof GrammyError && cause.error_code === 403) {
      deps.logger.warn(
        { description: cause.description },
        'Bot handler: forbidden (user blocked the bot)',
      );
      return;
    }

    // 2) Expected business outcome — friendly message, no dev page.
    if (cause instanceof DomainError) {
      deps.logger.warn(
        { code: cause.code, detail: cause.message },
        'Bot handler: domain error',
      );
      if (cause.userFacing) {
        await replyWithError(ctx, deps, lang);
        return;
      }
      // Non-user-facing domain error → treat as internal (fall through).
    } else {
      deps.logger.error({ err: cause, update: err.message }, 'Bot handler error');
    }

    // 3) Unexpected error → page the dev (best-effort firehose).
    deps.errorReporter.report({
      message: cause instanceof Error ? cause.message : String(cause),
      stack: cause instanceof Error ? cause.stack : undefined,
      context: { scope: 'bot.catch' },
    });

    // 4) Apologise to the user (best-effort).
    await replyWithError(ctx, deps, lang);
  };
}

async function replyWithError(
  ctx: BotContext,
  deps: BotErrorHandlerDeps,
  lang: SupportedLocale,
): Promise<void> {
  // Only message-bearing updates have a chat to reply into; inline queries /
  // poll answers / etc. have nowhere to send a notice.
  //
  // The condition used to be `ctx.chat?.id === undefined && ctx.from?.id ===
  // undefined`, which is not what the sentence above says. An inline query HAS
  // a `from` and no chat, so the `&&` never held and execution fell through to
  // `ctx.reply`, which throws 'Missing information for API call to sendMessage'.
  // That throw is caught below and logged as a failed apology, so every error
  // raised inside an inline handler was reported as a delivery problem instead
  // of as itself. The chat alone decides: `from` is who asked, not where to
  // answer.
  if (ctx.chat?.id === undefined) return;
  try {
    const keyboard = await buildSupportKeyboard(deps, lang);
    await ctx.reply(deps.translator.t('error.unknown', lang), {
      ...(keyboard !== null ? { reply_markup: keyboard } : {}),
      link_preview_options: { is_disabled: true },
    });
  } catch (sendErr: unknown) {
    deps.logger.warn({ err: sendErr }, 'Bot handler: failed to deliver error notice');
  }
}

async function buildSupportKeyboard(
  deps: BotErrorHandlerDeps,
  lang: SupportedLocale,
): Promise<InlineKeyboard | null> {
  let cfg: BotConfig | null = null;
  try {
    cfg = await deps.getConfig();
  } catch {
    /* config unavailable — fall back to the env handle below */
  }
  const adminHandle = (cfg?.visual.supportUsername ?? '').replace(/^@+/, '').trim();
  const handle = adminHandle.length > 0 ? adminHandle : (deps.envSupportUsername ?? '').trim();
  const url = resolveSupportDeepLink(handle, deps.translator.t('help.contact_prefill', lang));
  if (url === null) return null;
  // Same `help_contact` system button the help screens render — resolve the
  // operator's emoji tokens through the same path, or the one button a user
  // sees when something already went wrong shows a raw `:slug:`. An empty cfg
  // (upstream unavailable) is a valid input: nothing to substitute, no icon.
  const contact = renderSystemButton(
    deps.translator.t('help.contact_button', lang),
    'help_contact',
    cfg ?? {},
  );
  return new InlineKeyboard().url(
    contact.iconCustomEmojiId !== undefined
      ? { text: contact.text, icon_custom_emoji_id: contact.iconCustomEmojiId }
      : contact.text,
    url,
  );
}
