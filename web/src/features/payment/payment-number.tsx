/**
 * PaymentNumber
 * ─────────────
 * The payment's own number, with a copy button that says what really happened.
 *
 * Support finds a payment by this number, and before this a subscriber could
 * not see it anywhere: not on the screen a payment ends on
 * (`payment-return-page.tsx`), and not in the payment history
 * (`settings/transactions-page.tsx`). The copy goes through `copyText`, which
 * falls back to the selection path where `navigator.clipboard` is missing
 * (in-app browsers) and answers whether the value actually arrived — so
 * «Номер скопирован» is only said when it did, and a failure says so and leaves
 * the number selectable by hand (one tap selects all of it).
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

import { copyText } from "@/features/connect/clipboard";
import { cn } from "@/lib/utils";

/** How long «Номер скопирован» stays up after a copy that worked. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * The namespaces the panel's importers put in front of a payment brought over
 * from another platform (`bedolaga:4821`) — `altshop-importer.service.ts`,
 * `bedolaga-importer.service.ts` and `remnashop-importer.service.ts` in the
 * panel repository, which lists the same three as `IMPORTED_PAYMENT_ID_PREFIXES`.
 *
 * A subscriber is shown the number without it: the namespace names the
 * service they moved from, which is nothing they need to read, and support
 * finds the payment by the bare number too — the panel's payment search tries
 * each namespace in front of a number it is given.
 */
const IMPORTED_NAMESPACES = ["altshop", "bedolaga", "remnashop"] as const;

/** The number a subscriber is shown — and copies — for `paymentId`. */
export function displayPaymentNumber(paymentId: string): string {
  for (const namespace of IMPORTED_NAMESPACES) {
    const prefix = `${namespace}:`;
    if (paymentId.startsWith(prefix) && paymentId.length > prefix.length) {
      return paymentId.slice(prefix.length);
    }
  }
  return paymentId;
}

export function PaymentNumber({
  paymentId,
  className,
}: {
  readonly paymentId: string;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = displayPaymentNumber(paymentId);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    const copied = await copyText(shown);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setOutcome(copied ? "copied" : "failed");
    if (copied) resetTimer.current = setTimeout(() => setOutcome("idle"), COPIED_FEEDBACK_MS);
  };

  return (
    <div className={cn("flex flex-col gap-1 text-[11px]", className)}>
      <div className="flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span>{t("paymentNumber.label")}</span>
        <span className="select-all break-all font-mono font-medium">{shown}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("paymentNumber.copy")}
          title={t("paymentNumber.copy")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brand-primary)"
        >
          {outcome === "copied" ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      <p role="status" aria-live="polite" className={outcome === "failed" ? "text-red-400" : "text-emerald-400"}>
        {outcome === "copied"
          ? t("paymentNumber.copied")
          : outcome === "failed"
            ? t("paymentNumber.copyFailed")
            : ""}
      </p>
    </div>
  );
}
