/**
 * The bot's `payment_return` deep link — the way back to Telegram that
 * `/payment-return/telegram` puts behind its button
 * (`features/payment/payment-return-telegram-page.tsx`). The bot answers
 * `/start payment_return` with a button back into the Mini App
 * (`src/bot/pages/start.ts`).
 */

/** The `/start` payload the bot answers with a button back into the Mini App. */
const PAYMENT_RETURN_START = "payment_return";

/** A Telegram username: 5–32 letters, digits and underscores, starting with a letter. */
const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * The deep link, or `null` when the cabinet names no bot — or names something
 * that is not a username, which is then not put behind a button on the
 * operator's domain.
 */
export function telegramPaymentReturnLink(botUsername: string | null | undefined): string | null {
  const name = (botUsername ?? "").trim().replace(/^@+/, "");
  if (!TELEGRAM_USERNAME.test(name)) return null;
  return `https://t.me/${name}?start=${PAYMENT_RETURN_START}`;
}
