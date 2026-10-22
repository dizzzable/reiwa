/**
 * `/payment-return/telegram` — where a payment gateway sends a buyer who paid
 * from the Telegram Mini App (`src/lib/payment-return-url.ts` on the server).
 *
 * The gateway used to send them to `https://t.me/<bot>?start=payment_return`
 * itself. Its page runs wherever `openLink` opened it — Telegram's in-app
 * browser on Android, Safari, a desktop browser — and on an operator's Android
 * phones Telegram's in-app browser loaded that redirect as a t.me WEB PAGE,
 * whose script went on to `tg:resolve?…`. The web view knows no such scheme and
 * replaced the page with «Не удалось открыть веб-страницу»
 * (net::ERR_UNKNOWN_URL_SCHEME) — right after a payment that went through
 * (WATA, 0.9.7.71).
 *
 * ── A tap, never a redirect on load ─────────────────────────────────────────
 *
 * This page is the cabinet's own https page, so every one of those browsers
 * loads it. It does not leave by itself — a redirect from here would be the
 * same redirect that failed. The way back is a tap on the same deep link:
 * Telegram's in-app browser on Android resolves a t.me link it is navigated to
 * inside the app (`BotWebViewContainer.shouldOverrideUrlLoading` →
 * `Browser.isInternalUri`), and Safari and desktop browsers hand it to the app.
 * The bot answers `/start payment_return` with a button back into the Mini App
 * (`src/bot/pages/start.ts`), as it always did.
 *
 * ── Says neither "paid" nor "not paid" ──────────────────────────────────────
 *
 * The cabinet hands the gateway this one address for success and for failure
 * alike, and this page has no session to ask with — the in-app browser shares
 * none of the Mini App's. The Mini App under it, still on `/payment-return`,
 * polls the payment and says which. So this page only says where to look.
 *
 * Public, like `/connect/open`: declared outside `StealthLayout` in `App.tsx`,
 * and under `/payment-return` in the transport's public paths, so a stray 401
 * cannot bounce it to the sign-in form. Outside the shell, so it brings its own
 * scroller (`out-of-shell-scroller.test.tsx`).
 */
import { Send } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useBranding } from "@/lib/branding-provider";
import { telegramPaymentReturnLink } from "@/lib/telegram-payment-return";

export default function PaymentReturnTelegramPage() {
  const { t } = useTranslation();
  const { botUsername } = useBranding();
  const link = telegramPaymentReturnLink(botUsername);

  return (
    <div
      data-testid="payment-return-telegram"
      className="scroll-area relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-6 text-[color:var(--brand-foreground)]"
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col items-center justify-center gap-4 py-10 text-center">
        <span
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-full bg-(--brand-primary)/15 text-(--brand-primary)"
        >
          <Send className="size-7" />
        </span>
        <h1 className="text-xl font-semibold">{t("paymentAnim.backToTelegramTitle")}</h1>
        <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
          {t("paymentAnim.backToTelegramBody")}
        </p>
        {/* A same-window anchor: the tap is what Telegram's in-app browser
            resolves inside the app. Only once the cabinet names its bot. */}
        {link !== null && (
          <a
            data-payment-return-telegram-link=""
            href={link}
            className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] bg-[color:var(--brand-primary)] px-4 py-3 text-sm font-semibold text-[color:var(--brand-primary-fg)]"
          >
            <Send aria-hidden="true" className="size-4" />
            {t("paymentAnim.backToTelegramButton")}
          </a>
        )}
        <p className="text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">
          {t(link === null ? "paymentAnim.backToTelegramCloseOnly" : "paymentAnim.backToTelegramClose")}
        </p>
      </div>
    </div>
  );
}
