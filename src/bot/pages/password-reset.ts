/**
 * `t.me/<bot>?start=pwreset` — "send me a password reset link".
 *
 * The cabinet's "Forgot password?" screen offers this to anybody who does not
 * remember their LOGIN: the bot already knows who it is talking to, so the
 * customer types nothing. The panel issues a single-use, fifteen-minute token
 * for the web account linked to this Telegram id (`password-reset/telegram`),
 * and the message names the login, which is the other half of "I forgot".
 *
 * ── Where the button may point ──────────────────────────────────────────────
 *
 * The token is a live credential. The button is built here, on this bot's own
 * configured cabinet address (`publicWebUrl`), and `passwordResetUrl` refuses to
 * produce anything that does not stay on that origin — the same rule
 * `attachSigninTokenToCabinetUrl` applies to the sign-in token. A URL button,
 * not a Mini App one: the new password is for the browser cabinet, and a real
 * browser is where a password manager can save it.
 *
 * ── The channel gate does not apply ─────────────────────────────────────────
 *
 * Handled from `/start`, ahead of the gate, like `payment_return`: recovering
 * the web password is a way into the WEB cabinet, which the owner decided is
 * not behind «Канал обязателен» (14.09.2026).
 *
 * The token is never logged, and neither is the panel's answer.
 */
import { InlineKeyboard } from 'grammy';

import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { coerceLocale } from './coerce-locale.js';
import type { BotContext, PageDeps } from './types.js';

/** The `/start` payload the cabinet links to. */
export const PASSWORD_RESET_START_PAYLOAD = 'pwreset';

const TOKEN_SHAPE = /^[a-f0-9]{64}$/;

/**
 * `<cabinet origin>/reset-password#token=…`, or `null` when the result would not
 * be a Telegram-safe https URL on the cabinet's own origin.
 *
 * The token rides in the FRAGMENT: a browser never sends it to a server, so it
 * lands in no access log and no Referer. The reset page reads it from there
 * and wipes it from the address bar.
 */
export function passwordResetUrl(cabinetUrl: string | null, token: string): string | null {
  if (cabinetUrl === null || !TOKEN_SHAPE.test(token)) return null;
  let base: URL;
  try {
    base = new URL(cabinetUrl);
  } catch {
    return null;
  }
  const url = new URL('/reset-password', base.origin);
  url.hash = `token=${token}`;
  const href = url.toString();
  if (url.origin !== base.origin || !isTelegramSafeButtonUrl(href)) return null;
  return href;
}

export async function replyWithPasswordReset(
  ctx: BotContext,
  deps: PageDeps,
  telegramId: number,
): Promise<void> {
  const lang = coerceLocale(deps.userLocale.getSync(telegramId));
  const say = (key: string, vars?: Record<string, string>): Promise<unknown> =>
    ctx.reply(deps.translator.t(key, lang, vars));

  if (deps.adminClient === null || deps.urls.publicWebUrl === null) {
    await say('password_reset.unavailable');
    return;
  }

  let result: Awaited<ReturnType<NonNullable<PageDeps['adminClient']>['webAuth']['issuePasswordResetForTelegram']>>;
  try {
    result = await deps.adminClient.webAuth.issuePasswordResetForTelegram(String(telegramId));
  } catch (err: unknown) {
    // An older panel answers 404; either way there is no link to give.
    deps.logger?.warn(
      { telegramId, err: err instanceof Error ? err.message : String(err) },
      'bot/password-reset: the panel did not issue a link',
    );
    await say('password_reset.unavailable');
    return;
  }

  switch (result.status) {
    case 'issued': {
      const href = passwordResetUrl(deps.urls.publicWebUrl, result.token);
      if (href === null) {
        await say('password_reset.unavailable');
        return;
      }
      const keyboard = new InlineKeyboard().url(deps.translator.t('password_reset.button', lang), href);
      // No parse mode: a login is `[A-Za-z0-9._-]`, and plain text cannot be
      // broken by one either way.
      await ctx.reply(deps.translator.t('password_reset.link', lang, { login: result.login }), {
        reply_markup: keyboard,
      });
      return;
    }
    case 'no_account':
      await say('password_reset.no_account');
      return;
    // Each refusal says what actually happened: "one was just sent" only when
    // one really was, and never when the panel simply could not count.
    case 'recently_sent':
      await say('password_reset.recently_sent');
      return;
    case 'hourly_limit':
      await say('password_reset.hourly_limit');
      return;
    default:
      await say('password_reset.unavailable');
  }
}
