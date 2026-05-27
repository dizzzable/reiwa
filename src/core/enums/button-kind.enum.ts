/**
 * Inline-keyboard button kinds the reiwa bot emits.
 *
 * The admin panel only manages visual properties (label / order / style /
 * emoji / one-per-row). The *kind* of each well-known `buttonId` is
 * hardcoded in core so admin operators cannot accidentally turn a
 * "browser-only" CTA into a Mini App button or vice-versa.
 *
 *   - `url`      external link in Telegram in-app browser. Used for the
 *                "Мой кабинет" CTA — pushes the user out of the bot into
 *                a real browser session for credential setup. Telegram
 *                rejects http://localhost; the safety guard in the
 *                widget filters those automatically.
 *   - `webapp`   opens the Mini App. HTTPS-only (Telegram requirement).
 *   - `callback` emits `callback_data === buttonId`; routed by reiwa's
 *                `bot.callbackQuery(id, ...)` handlers.
 */
export type ButtonKind = 'url' | 'webapp' | 'callback';

export interface ButtonBinding {
  readonly kind: ButtonKind;
  /** Optional path appended to the resolved base URL (`/`, `/subscribe`, ...). */
  readonly path?: string;
}
