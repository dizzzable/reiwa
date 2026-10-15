/**
 * The payment step: the customer's saved ЮKassa cards, every gateway, and under
 * each gateway its «для автоматического списания» where the panel offers it for
 * this purchase (`lib/autopay-offer.ts`).
 *
 * Shared by the purchase wizard and «Сменить тариф»: a plan change is paid
 * every way a purchase is (the owner, 15.10.2026 — it offered the ordinary
 * payment alone before). Each page keeps its own store; this takes what it
 * shows and says what was chosen.
 */
import { Fragment, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CreditCard } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getEnabledGateways, getPaymentMethods } from "@/lib/api-client";
import type { GatewayOption } from "@/stores/purchase.store";
import type { PlanPrice } from "@/types/api";
import { cn } from "@/lib/utils";
import { gatewayLabel } from "@/lib/gateway-display";
import {
  autopayCaptionKey,
  autopayHintKey,
  type AutopayGateway,
  autopayOptions,
  offersAutopay,
} from "@/lib/autopay-offer";
import { autopayDelayFor, describeAutopayDelay } from "@/lib/autopay-delay";
import { AutopayGatewayMark, GatewayIcon } from "@/components/ui/gateway-icon";
import {
  formatSavedPaymentMethodMeta,
  formatSavedPaymentMethodTitle,
} from "@/lib/saved-payment-method-display";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

/** A price the way the quote prints it: the symbol, two decimals and the currency. */
export function formatPaymentAmount(price: number | string, currency: string): string {
  return `${CURRENCY_SYMBOLS[currency] ?? ""}${Number(price).toFixed(2)} ${currency}`;
}

const GATEWAY_ICONS: Record<string, string> = {
  YOOKASSA: "💳",
  YOOMONEY: "💳",
  TBANK: "🏦",
  ROBOKASSA: "💳",
  CRYPTOMUS: "₿",
  HELEKET: "💎",
  CRYPTOPAY: "₿",
  STRIPE: "💲",
  TELEGRAM_STARS: "⭐",
  MULENPAY: "💳",
  CLOUDPAYMENTS: "☁️",
  PAL24: "💳",
  WATA: "💳",
  PLATEGA: "💳",
};

/** What is being paid for, as far as «для автоматического списания» goes. */
export interface GatewayPickerPurchase {
  readonly durationDays: number;
  /** The price on this gateway as the catalogue lists it; undefined where it lists none. */
  readonly priceFor: (gatewayType: string) => Pick<PlanPrice, "currency" | "price" | "discountSource"> | undefined;
  readonly isTrial: boolean;
}

export function GatewayPicker({
  purchase,
  selectedGateway,
  selectedSavedPaymentMethodId,
  onSelect,
  onSelectSaved,
  autoSelect,
}: {
  /** Null while the page does not know it yet: no provider's option is offered then. */
  purchase: GatewayPickerPurchase | null;
  selectedGateway: GatewayOption | null;
  selectedSavedPaymentMethodId: string | null;
  onSelect: (gateway: GatewayOption) => void;
  /** A saved ЮKassa card: the gateway, and the card on it. */
  onSelectSaved: (gateway: GatewayOption, methodId: string) => void;
  /**
   * Whether a lone gateway may be chosen without a tap — only on the way in.
   * Without it, Back from the next step re-mounts this and re-advances (a trap).
   */
  autoSelect: boolean;
}) {
  const { t } = useTranslation();
  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });
  // A provider's option only where it can repeat this exact sum and term.
  const autopayOffered = (gw: AutopayGateway) =>
    offersAutopay({
      gatewayType: gw.type,
      autopay: gw.autopay,
      autopayMethods: gw.autopayMethods,
      purchase:
        purchase === null
          ? null
          : { durationDays: purchase.durationDays, price: purchase.priceFor(gw.type), isTrial: purchase.isTrial },
    });
  const yookassaEnabled = gateways.some((gw) => gw.type === "YOOKASSA" && gw.isActive !== false);
  const { data: paymentMethodsData, isPending: paymentMethodsPending } = useQuery({
    queryKey: ["payment-methods"],
    queryFn: getPaymentMethods,
    enabled: yookassaEnabled,
    staleTime: 15_000,
    retry: false,
  });
  const savedYookassaMethods = (paymentMethodsData?.methods ?? []).filter(
    (method) => method.gatewayType === "YOOKASSA" && method.autopayEnabled !== false,
  );
  const option = (gw: { type: string; displayName: string; currency: string }): GatewayOption => ({
    id: gw.type,
    label: gatewayLabel(gw.type, gw.displayName),
    icon: GATEWAY_ICONS[gw.type] ?? "💳",
    currency: gw.currency,
  });

  // A lone gateway is chosen for the customer — and never over a saved card:
  // for a ЮKassa subscriber this screen offers "charge a saved card" beside "new
  // payment page", which is a choice even with one gateway. Decided only once
  // the cards are known — while their read is still out, "no cards yet" looks
  // exactly like "no cards". Nor over a gateway offering «для автоматического
  // списания»: that is a second option.
  const savedMethodsUnknown = yookassaEnabled && paymentMethodsPending;
  useEffect(() => {
    if (
      !isLoading &&
      gateways.length === 1 &&
      !autopayOffered(gateways[0]) &&
      autoSelect &&
      !savedMethodsUnknown &&
      savedYookassaMethods.length === 0
    ) {
      onSelect(option(gateways[0]));
    }
  }, [isLoading, gateways, autoSelect, savedMethodsUnknown, savedYookassaMethods.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sort: in TMA context, put Telegram Stars first
  const isTma = !!window.Telegram?.WebApp?.initData;
  const sortedGateways = [...gateways].sort((a, b) => {
    if (isTma) {
      if (a.type === "TELEGRAM_STARS") return -1;
      if (b.type === "TELEGRAM_STARS") return 1;
    }
    return 0;
  });

  if (isLoading)
    return (
      <div className="px-5 space-y-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="theme-skeleton h-16 animate-pulse rounded-2xl"
          />
        ))}
      </div>
    );

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("purchase.gateway.title")}</h2>
      {savedYookassaMethods.length > 0 && (
        <div className="px-5 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("purchase.gateway.savedTitle")}
          </p>
          {savedYookassaMethods.map((method) => {
            const selected =
              selectedGateway?.id === "YOOKASSA" && selectedSavedPaymentMethodId === method.id;
            return (
              <button
                key={method.id}
                type="button"
                onClick={() => {
                  const yookassa = gateways.find((gw) => gw.type === "YOOKASSA");
                  if (!yookassa) return;
                  onSelectSaved(option(yookassa), method.id);
                }}
                className={cn(
                  "w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all",
                  selected && "border-(--brand-primary)/40 bg-(--brand-primary)/5",
                )}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-violet-500/10 text-violet-300">
                  <CreditCard className="h-4 w-4" />
                </span>
                <div className="min-w-0 text-left">
                  <p className="truncate font-medium text-foreground">
                    {formatSavedPaymentMethodTitle(method, t)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatSavedPaymentMethodMeta(method, t)}
                  </p>
                </div>
                {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-(--brand-primary)" />}
              </button>
            );
          })}
        </div>
      )}
      <div className="px-5 space-y-2">
        {sortedGateways.map((gw) => (
          <Fragment key={gw.type}>
            <button
              onClick={() => onSelect(option(gw))}
              className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
            >
              <span className="flex h-7 w-7 items-center justify-center text-2xl">
                <GatewayIcon type={gw.type} currency={gw.currency} className="h-7 w-7" />
              </span>
              <div className="text-left">
                <p className="font-medium text-foreground">{gatewayLabel(gw.type, gw.displayName)}</p>
                <p className="text-xs text-muted-foreground">{gw.currency}</p>
              </div>
            </button>
            {autopayOffered(gw) &&
              autopayOptions(gw).map((method) => {
                // An SBP sign-up with a delayed first charge says so where it is
                // chosen: nothing is charged now, the plan is theirs at once.
                const delay = autopayDelayFor(gw, method);
                const price = purchase?.priceFor(gw.type);
                const caption =
                  delay === null
                    ? t(autopayCaptionKey(method, gw.type))
                    : t("purchase.gateway.autopayCaptionSbpDelay", {
                        delay: describeAutopayDelay(t, delay),
                        amount: price === undefined ? "—" : formatPaymentAmount(price.price, price.currency),
                      });
                return (
                  <button
                    key={method ?? "autopay"}
                    onClick={() =>
                      onSelect({
                        ...option(gw),
                        label: `${gatewayLabel(gw.type, gw.displayName)} · ${t(autopayCaptionKey(method, gw.type))}`,
                        autopay: true,
                        ...(method === null ? {} : { autopayMethod: method }),
                        ...(delay === null ? {} : { autopayDelay: delay }),
                      })
                    }
                    className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
                  >
                    <AutopayGatewayMark type={gw.type} currency={gw.currency} method={method} />
                    <div className="text-left">
                      <p className="font-medium text-foreground">{gatewayLabel(gw.type, gw.displayName)}</p>
                      <p className="text-xs text-muted-foreground">{caption}</p>
                    </div>
                  </button>
                );
              })}
          </Fragment>
        ))}
        {gateways.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t("purchase.gateway.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Picking «для автоматического списания» is the customer's consent to it; this
 * says what that consent means before they pay. Nothing for any other payment,
 * and nothing for a saved card, which is charged as it is.
 */
export function AutopayConsentNotice({
  gateway,
  savedPaymentMethodId,
  amount,
  currency,
  durationDays,
}: {
  gateway: GatewayOption | null;
  savedPaymentMethodId: string | null;
  amount: number;
  currency: string;
  durationDays: number;
}) {
  const { t } = useTranslation();
  if (gateway?.autopay !== true || savedPaymentMethodId) return null;
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-snug text-foreground">
      <p className="font-medium">{t("purchase.quote.autopayTitle")}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {gateway.autopayDelay !== undefined
          ? // Nothing is charged now: the plan is theirs for the delay, the first
            // charge is this sum, after it, and then every term.
            t("purchase.quote.autopayDelayHint", {
              delay: describeAutopayDelay(t, gateway.autopayDelay),
              amount: formatPaymentAmount(amount, currency),
              term: t("purchase.duration.days", { count: durationDays }),
            })
          : t(autopayHintKey(gateway.id, gateway.autopayMethod))}
      </p>
    </div>
  );
}
