import { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, Check, CreditCard } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getActionPolicy,
  getQuote,
  createCheckout,
  createUpgradeCheckout,
  getEnabledGateways,
  activatePromocode,
  getPaymentMethods,
  type CreationPurchaseType,
} from "@/lib/api-client";
import { getPartnerInfo, payWithPartnerBalance } from "@/lib/api-client";
import { PartnerBalanceHoldNotice } from "@/features/partner/partner-balance-hold-notice";
import { balanceHoldRefusalMessage, standingBalanceHold } from "@/lib/partner-balance-hold";
import { readSessionCheckRefusal } from "@/lib/session-check";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { usePurchaseStore } from "@/stores/purchase.store";
import { useBranding } from "@/lib/branding-provider";
import { useAccessMode } from "@/lib/use-access-mode";
import { savePendingCheckout } from "@/lib/pending-checkout";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import {
  saveSubscriptionProvisioningReceipt,
  type SubscriptionProvisioningSlotIndexSource,
} from "@/lib/subscription-provisioning-receipt";
import { AccessModeBlockedScreen } from "@/components/access-mode-banner";
import { PromoInput } from "./components/promo-input";
import {
  isPlanUnavailableRefusal,
  isQuoteNotEligibleRefusal,
  notifyPlanUnavailable,
  readUnpricedQuote,
  TRIAL_CLAIM_REFUSAL_KEYS,
} from "./plan-unavailable";
import type { GatewayOption } from "@/stores/purchase.store";
import type { Plan, PlanDuration } from "@/types/api";
import { cn, startCheckoutRedirect } from "@/lib/utils";
import { gatewayLabel } from "@/lib/gateway-display";
import {
  autopayRefusalMessage,
  isAutopayNotAvailableRefusal,
  isProviderSubscriptionGateway,
  offersAutopay,
} from "@/lib/autopay-offer";
import { AutopayGatewayMark, GatewayIcon } from "@/components/ui/gateway-icon";
import {
  formatSavedPaymentMethodMeta,
  formatSavedPaymentMethodTitle,
} from "@/lib/saved-payment-method-display";
import { toast } from "sonner";
import {
  isSubscriptionLimitError,
  isSubscriptionLimitReached,
  notifySubscriptionLimitReached,
} from "@/lib/subscription-limit";
import { isTrialConversionRequiredRefusal, useTrialToConvert } from "@/lib/trial-conversion";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

/**
 * Exported for `web/test/purchase-duration-cashback.test.tsx`: this step is a
 * self-contained presentational unit, and reaching it through `PurchasePage`
 * would mean standing up the store, the access-mode gate, react-query and the
 * whole checkout chain to assert one pill. Same precedent as
 * `invalidatePaymentReturnSuccessQueries`.
 */
export function SelectDuration({
  plan,
  preferredCurrency,
  onSelect,
}: {
  plan: Plan;
  preferredCurrency: string;
  onSelect: (d: PlanDuration) => void;
}) {
  const { t } = useTranslation();
  const lastNav = usePurchaseStore((s) => s.lastNav);

  // Auto-select + advance when the plan offers exactly one duration — but
  // ONLY when arriving forward. Without the guard, pressing "back" from the
  // payment-method step re-mounts this and immediately re-advances (a trap).
  useEffect(() => {
    if (plan.durations.length === 1 && lastNav === "forward") {
      onSelect(plan.durations[0]!);
    }
  }, [plan, lastNav]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("purchase.duration.title")}</h2>
      <div className="px-5 space-y-2">
        {plan.durations.map((dur: PlanDuration) => {
          const preferred = dur.prices.find((p) => p.currency === preferredCurrency);
          const usdPrice = dur.prices.find((p) => p.currency === "USD");
          const rubPrice = dur.prices.find((p) => p.currency === "RUB");
          const displayPrice = preferred ?? usdPrice ?? rubPrice ?? dur.prices[0];
          // Absent / null / 0 / a non-number from an older panel all mean the
          // same thing here: say nothing about points for this duration.
          const cashbackPoints =
            typeof dur.cashbackPoints === "number" && Number.isFinite(dur.cashbackPoints)
              ? dur.cashbackPoints
              : 0;
          return (
            <button
              key={dur.id}
              onClick={() => onSelect(dur)}
              className="w-full glass-card p-4 flex items-center justify-between hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
            >
              <div className="text-left">
                <p className="font-medium text-foreground">
                  {t("purchase.duration.days", { count: dur.days })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {dur.days >= 365
                    ? t("purchase.duration.year")
                    : dur.days >= 30
                      ? t("purchase.duration.months", { count: Math.round(dur.days / 30) })
                      : t("purchase.duration.days", { count: dur.days })}
                </p>
              </div>
              {/* The price column also carries the loyalty cashback for THIS
                  duration — the exact number, unlike the "up to" summary on
                  the tariff card. It sits outside the `displayPrice` guard so
                  a duration the operator priced without a gateway still shows
                  what it earns. */}
              <div className="flex flex-col items-end gap-0.5">
                {displayPrice && (() => {
                  const hasDiscount =
                    (displayPrice.discountPercent ?? 0) > 0 &&
                    displayPrice.discountSource !== undefined &&
                    displayPrice.discountSource !== "NONE" &&
                    displayPrice.originalPrice !== undefined;
                  const sym = CURRENCY_SYMBOLS[displayPrice.currency] ?? "";
                  return (
                    <>
                      {hasDiscount && (
                        <div className="flex items-center gap-1.5">
                          <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-400/30">
                            −{displayPrice.discountPercent}%
                          </span>
                          <span className="text-[11px] text-muted-foreground line-through">
                            {sym}
                            {Number(displayPrice.originalPrice).toFixed(2)}
                          </span>
                        </div>
                      )}
                      <p className="text-(--brand-primary) font-semibold">
                        {sym}
                        {Number(displayPrice.price).toFixed(2)}
                      </p>
                    </>
                  );
                })()}
                {cashbackPoints > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">
                    {t("purchase.duration.cashback", { count: cashbackPoints })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
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

function SelectGateway({
  onSelect,
  convertsTrial,
}: {
  onSelect: (gw: GatewayOption) => void;
  /** The purchase converts the buyer's trial: an UPGRADE, see `offersAutopay`. */
  convertsTrial: boolean;
}) {
  const { t } = useTranslation();
  const lastNav = usePurchaseStore((s) => s.lastNav);
  const selectedGateway = usePurchaseStore((s) => s.selectedGateway);
  const selectedSavedPaymentMethodId = usePurchaseStore((s) => s.selectedSavedPaymentMethodId);
  const selectSavedPaymentMethod = usePurchaseStore((s) => s.selectSavedPaymentMethod);
  const selectedPlan = usePurchaseStore((s) => s.selectedPlan);
  const selectedDuration = usePurchaseStore((s) => s.selectedDuration);
  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });
  // Platega's option only where the provider can repeat this exact sum and term.
  // A trial's conversion is an UPGRADE the provider can repeat: it is priced
  // like a new purchase, and the later charges renew the converted trial.
  const autopayOffered = (gw: { type: string; autopay?: boolean }) =>
    offersAutopay({
      gatewayType: gw.type,
      autopay: gw.autopay,
      purchase:
        selectedDuration === null
          ? null
          : {
              durationDays: selectedDuration.days,
              price: selectedDuration.prices.find((price) => price.gatewayType === gw.type),
              isTrial: selectedPlan?.isTrial === true,
              planChange: convertsTrial,
              convertsTrial,
            },
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

  // Auto-select if only one gateway is available — but ONLY when the user
  // arrived here going forward. Without the guard, pressing "back" from the
  // quote step re-mounts this and immediately re-advances (a trap).
  //
  // And never over a saved card: for a YooKassa subscriber this screen offers
  // "charge a saved card" beside "new payment page", which is a choice even
  // with one gateway. Decide only once the cards are known — while their read
  // is still out, "no cards yet" looks exactly like "no cards". Nor over a
  // gateway offering «для автоматического списания»: that is a second option.
  const savedMethodsUnknown = yookassaEnabled && paymentMethodsPending;
  useEffect(() => {
    if (
      !isLoading &&
      gateways.length === 1 &&
      !autopayOffered(gateways[0]) &&
      lastNav === "forward" &&
      !savedMethodsUnknown &&
      savedYookassaMethods.length === 0
    ) {
      const gw = gateways[0];
      onSelect({
        id: gw.type,
        label: gatewayLabel(gw.type, gw.displayName),
        icon: GATEWAY_ICONS[gw.type] ?? "💳",
        currency: gw.currency,
      });
    }
  }, [isLoading, gateways, lastNav, savedMethodsUnknown, savedYookassaMethods.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
                  onSelect({
                    id: yookassa.type,
                    label: gatewayLabel(yookassa.type, yookassa.displayName),
                    icon: GATEWAY_ICONS[yookassa.type] ?? "💳",
                    currency: yookassa.currency,
                  });
                  // selectGateway clears saved method; re-apply after store update.
                  queueMicrotask(() => selectSavedPaymentMethod(method.id));
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
              onClick={() =>
                onSelect({
                  id: gw.type,
                  label: gatewayLabel(gw.type, gw.displayName),
                  icon: GATEWAY_ICONS[gw.type] ?? "💳",
                  currency: gw.currency,
                })
              }
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
            {autopayOffered(gw) && (
              <button
                onClick={() =>
                  onSelect({
                    id: gw.type,
                    label: `${gatewayLabel(gw.type, gw.displayName)} · ${t("purchase.gateway.autopayCaption")}`,
                    icon: GATEWAY_ICONS[gw.type] ?? "💳",
                    currency: gw.currency,
                    autopay: true,
                  })
                }
                className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
              >
                <AutopayGatewayMark type={gw.type} currency={gw.currency} />
                <div className="text-left">
                  <p className="font-medium text-foreground">{gatewayLabel(gw.type, gw.displayName)}</p>
                  <p className="text-xs text-muted-foreground">{t("purchase.gateway.autopayCaption")}</p>
                </div>
              </button>
            )}
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
 * Leaves the wizard over a plan that is no longer offered: says so, drops the
 * catalogue that offered it and returns to a freshly loaded list.
 */
function useLeaveWithdrawnPlan(): () => void {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const reset = usePurchaseStore((s) => s.reset);
  return () => {
    notifyPlanUnavailable(t);
    // Reset, not invalidate: an invalidated catalogue is still RENDERED
    // while it refetches, which would put the withdrawn plan back under the
    // buyer's tap on the very list they are sent to.
    void queryClient.resetQueries({ queryKey: ["plans"] });
    reset();
    navigate("/plans", { replace: true });
  };
}

/**
 * The panel would not create a subscription: the buyer holds a trial this page
 * did not know of — claimed in another tab, or after the list was read. Nothing
 * was charged. Re-reading the list makes this purchase that trial's conversion,
 * so the quote on screen is priced again as one and the buyer pays from it.
 */
function useNoticeTrialConversion(): () => void {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return () => {
    toast.warning(t("purchase.checkout.trialConversionRequired"), { duration: 6_000 });
    void queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.actionPolicyRoot });
  };
}

/** The notice a held partner balance puts under its disabled button. */
const PURCHASE_BALANCE_HOLD_NOTICE_ID = "purchase-partner-balance-hold";

function QuoteView({
  purchaseType,
  slotIndex,
  slotIndexSource,
  convertTrialId,
  refused,
}: {
  purchaseType: CreationPurchaseType;
  slotIndex: number;
  slotIndexSource: SubscriptionProvisioningSlotIndexSource;
  /**
   * The trial this purchase converts (`lib/trial-conversion`), or null for a
   * purchase that creates a subscription. Set, the quote and both payments are
   * an UPGRADE of it, and there is no new subscription to wait for.
   */
  convertTrialId: string | null;
  /** The panel refused this very quote at checkout without saying why — see `CheckoutStep`. */
  refused: boolean;
}) {
  const { t, i18n } = useTranslation();
  const {
    step,
    selectedPlan,
    selectedDuration,
    selectedGateway,
    selectedSavedPaymentMethodId,
    setQuote,
    goBack,
  } = usePurchaseStore();
  // `AnimatePresence mode="wait"` keeps a step it is leaving mounted for its
  // exit (about 200 ms), and that copy keeps re-rendering from the store.
  const isCurrentStep = step === "quote";
  // Picking «для автоматического списания» is the customer's consent to save
  // the method; this says what that consent means before they pay.
  const showAutopayNotice = selectedGateway?.autopay === true && !selectedSavedPaymentMethodId;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: partner } = useQuery({
    queryKey: ["partner", "info"],
    queryFn: getPartnerInfo,
    staleTime: 60_000,
  });
  const { data: paymentMethodsData } = useQuery({
    queryKey: ["payment-methods"],
    queryFn: getPaymentMethods,
    enabled: selectedGateway?.id === "YOOKASSA" && !!selectedSavedPaymentMethodId,
    staleTime: 15_000,
    retry: false,
  });
  const savedMethodLabel = paymentMethodsData?.methods.find(
    (method) => method.id === selectedSavedPaymentMethodId,
  );

  const noticeTrialConversion = useNoticeTrialConversion();

  const {
    data: quote,
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      "quote",
      selectedPlan?.id,
      selectedDuration?.days,
      selectedGateway?.id,
      convertTrialId,
    ],
    queryFn: () =>
      convertTrialId === null
        ? getQuote(selectedPlan!.id, selectedDuration!.days, selectedGateway!.id)
        : getQuote(
            selectedPlan!.id,
            selectedDuration!.days,
            selectedGateway!.id,
            "UPGRADE",
            convertTrialId,
          ),
    enabled: !!(selectedPlan && selectedDuration && selectedGateway),
  });

  // An unpriced quote says why. A plan or term no longer offered is answered
  // like the checkout refusal below — this is the more common way to meet it,
  // the plan being gone before the quote was priced. Told "try a different
  // payment method" instead, the buyer went back to a catalogue that kept
  // offering the plan for as long as it stayed cached.
  const unpriced =
    !isLoading &&
    !error &&
    quote !== undefined &&
    (quote.warning !== undefined || typeof quote.finalPrice !== "number");
  const verdict = unpriced ? readUnpricedQuote(quote, selectedPlan?.isTrial === true) : null;
  const withdrawn = verdict?.kind === "withdrawn";
  const leaveWithdrawnPlan = useLeaveWithdrawnPlan();
  // StrictMode runs a mount effect twice. This step used to mount with the page,
  // and leaving reset the store before the second run could come; it now mounts
  // once the subscription list is read (a trial changes what is priced), and in
  // that commit the second run comes first. A ref survives the simulated
  // remount — the upgrade review's latch, for the same reason.
  const leftWithdrawnPlan = useRef(false);
  useEffect(() => {
    if (!withdrawn || leftWithdrawnPlan.current) return;
    leftWithdrawnPlan.current = true;
    leaveWithdrawnPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawn]);

  const balanceMutation = useMutation({
    mutationFn: async () => {
      const result = await payWithPartnerBalance({
        purchaseType: convertTrialId === null ? purchaseType : "UPGRADE",
        planId: String(selectedPlan!.id),
        durationDays: selectedDuration!.days,
        subscriptionId: convertTrialId ?? undefined,
      });
      if (!result.paymentId) {
        throw new Error("Partner balance payment did not return a paymentId");
      }
      return { ...result, paymentId: result.paymentId };
    },
    onSuccess: (result) => {
      // A converted trial is the subscription the buyer already has: nothing
      // new appears for the dashboard to wait for.
      if (convertTrialId === null) {
        saveSubscriptionProvisioningReceipt({
          paymentId: result.paymentId,
          purchaseType,
          slotIndex,
          slotIndexSource,
          phase: "PROVISIONING",
        });
      }
      toast.success(t("purchase.quote.balancePaid"));
      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.actionPolicyRoot,
      });
      void queryClient.invalidateQueries({ queryKey: ["partner", "info"] });
      navigate("/dashboard", { replace: true });
    },
    onError: (err) => {
      // The check before money moves (`lib/session-check.ts`): signed out
      // elsewhere — the transport is already on its way to sign-in — or the
      // panel could not say, and nothing was paid.
      const sessionRefusal = readSessionCheckRefusal(err);
      if (sessionRefusal !== null) {
        if (sessionRefusal === "unavailable") toast.error(t("auth.sessionCheckUnavailable"));
        return;
      }
      // The balance went on hold after this page read the partner info: say
      // so, and re-read it so the notice below the button takes over.
      const holdMessage = balanceHoldRefusalMessage(
        err,
        t,
        partner?.balanceHold?.timezone ?? null,
        i18n.language,
      );
      if (holdMessage !== null) {
        toast.error(holdMessage);
        void queryClient.invalidateQueries({ queryKey: ["partner", "info"] });
        return;
      }
      if (isTrialConversionRequiredRefusal(err)) {
        noticeTrialConversion();
        return;
      }
      if (isSubscriptionLimitError(err)) {
        notifySubscriptionLimitReached(t);
        navigate("/dashboard", { replace: true });
        return;
      }
      toast.error(t("purchase.quote.balanceError"));
    },
  });
  const balanceHold = standingBalanceHold(partner?.balanceHold);

  if (isLoading || withdrawn) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    );
  }

  if (verdict?.kind === "trial") {
    // A paid trial this buyer cannot claim. It stays in the catalogue, so this
    // is not a withdrawal, and no other payment method would help either.
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="danger">{t(TRIAL_CLAIM_REFUSAL_KEYS[verdict.code]!)}</TipCard>
        {verdict.code === "TRIAL_REQUIRES_TELEGRAM" && (
          <StadiumButton fullWidth onClick={() => navigate("/settings/privacy?link=telegram")}>
            {t("trialCta.buttonLinkTelegram")}
          </StadiumButton>
        )}
        <StadiumButton fullWidth variant="secondary" onClick={goBack}>
          {t("purchase.back")}
        </StadiumButton>
      </div>
    );
  }

  if (error || !quote || quote.warning || typeof quote.finalPrice !== "number") {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="danger">{t("purchase.quote.priceError")}</TipCard>
        <StadiumButton fullWidth variant="secondary" onClick={goBack}>
          {t("purchase.back")}
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="px-5 space-y-4">
      <h2 className="text-base font-semibold">{t("purchase.quote.title")}</h2>

      {/* What is being paid for differs from the plain purchase, so it is said
          where the price is: the trial becomes this plan, and its link stays. */}
      {convertTrialId !== null && (
        <TipCard tone="info">{t("purchase.quote.trialConversion", { plan: quote.planName })}</TipCard>
      )}

      <div className="glass-card divide-y divide-border overflow-hidden">
        <Row label={t("purchase.quote.plan")} value={quote.planName} />
        <Row
          label={t("purchase.quote.duration")}
          value={t("purchase.duration.days", { count: quote.durationDays })}
        />
        <Row
          label={t("purchase.quote.method")}
          value={selectedGateway?.label ?? "—"}
          icon={
            selectedGateway ? (
              <GatewayIcon
                type={selectedGateway.id}
                currency={selectedGateway.currency}
                className="h-4 w-4"
              />
            ) : undefined
          }
        />
        {savedMethodLabel && (
          <Row
            label={t("purchase.quote.savedMethod")}
            value={formatSavedPaymentMethodTitle(savedMethodLabel, t)}
          />
        )}
        {quote.discountPercent > 0 && (
          <Row
            label={t("purchase.quote.discount")}
            value={`-${quote.discountPercent}%`}
            accent="text-emerald-400"
          />
        )}
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="font-semibold">{t("purchase.quote.total")}</span>
          <span className="text-lg font-bold text-(--brand-primary)">
            {CURRENCY_SYMBOLS[quote.currency] ?? ""}
            {quote.finalPrice.toFixed(2)} {quote.currency}
          </span>
        </div>
      </div>

      {/* Promo code input */}
      <PromoInput
        onPromoApplied={(code) => {
          if (code) {
            void queryClient.invalidateQueries({ queryKey: ["quote"] });
          }
        }}
        validatePromo={async (code) => {
          const result = await activatePromocode(code);
          // Only an actual activation counts as "applied"; rejections / pending
          // steps must surface as an error instead of a false green check.
          if (result.step !== "ACTIVATED") {
            throw new Error(result.errorCode ?? "PROMO_NOT_APPLIED");
          }
        }}
      />

      {showAutopayNotice && (
        <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-snug text-foreground">
          <p className="font-medium">{t("purchase.quote.autopayTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              isProviderSubscriptionGateway(selectedGateway?.id)
                ? "purchase.quote.autopayProviderHint"
                : "purchase.quote.autopayHint",
            )}
          </p>
        </div>
      )}

      {/* The panel already refused exactly this quote and did not say why, yet
          prices it again: not a withdrawn plan, and not something another press
          of Pay would change. Say so instead of offering that press. */}
      {refused && <TipCard tone="danger">{t("purchase.checkout.notAccepted")}</TipCard>}
      {/* One purchase, one payment. The balance pays in place with this quote
          still on screen, and Pay stayed live beside it: while that payment was
          out, and after it went through, Pay created a gateway checkout for the
          same purchase. So Pay takes no tap while a balance payment is out or
          done; a failed one gives it back. Neither button takes one once this
          quote is not the step on screen: it stays mounted for its exit, still
          priced, so a quote leaving for checkout still paid from the balance,
          and one left for the gateway step («Изменить», the header back) still
          started a checkout. */}
      {!refused && (
        <StadiumButton
          fullWidth
          size="lg"
          onClick={() => setQuote(quote)}
          glow
          icon={<Check className="h-5 w-5" />}
          disabled={!isCurrentStep || balanceMutation.isPending || balanceMutation.isSuccess}
        >
          {t("purchase.quote.pay")}
        </StadiumButton>
      )}
      {/* On hold after a password recovery the balance is still offered — so
          the buyer sees which option it is — but it takes no tap, and the
          notice under it says for how long and why. */}
      {!refused &&
        partner &&
        partner.isActive &&
        partner.balancePaymentEnabled &&
        partner.balanceCurrency === quote.currency &&
        partner.balance >= Math.round(quote.finalPrice * 100) && (
          <>
            <StadiumButton
              fullWidth
              variant="secondary"
              loading={balanceMutation.isPending}
              disabled={!isCurrentStep || balanceMutation.isSuccess || balanceHold !== null}
              aria-describedby={balanceHold ? PURCHASE_BALANCE_HOLD_NOTICE_ID : undefined}
              onClick={() => balanceMutation.mutate()}
            >
              {t("purchase.quote.payWithBalance", {
                amount: (partner.balance / 100).toFixed(2),
                currency: partner.balanceCurrency,
              })}
            </StadiumButton>
            {balanceHold && (
              <PartnerBalanceHoldNotice hold={balanceHold} id={PURCHASE_BALANCE_HOLD_NOTICE_ID} />
            )}
          </>
        )}
      <StadiumButton fullWidth variant="ghost" onClick={goBack}>
        {t("purchase.quote.change")}
      </StadiumButton>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string;
  accent?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium flex items-center gap-1.5", accent)}>
        {icon && <span aria-hidden="true">{icon}</span>}
        {value}
      </span>
    </div>
  );
}

function CheckoutStep({
  purchaseType,
  slotIndex,
  slotIndexSource,
  convertTrialId,
  onQuoteRefused,
}: {
  purchaseType: CreationPurchaseType;
  slotIndex: number;
  slotIndexSource: SubscriptionProvisioningSlotIndexSource;
  /** The trial this purchase converts, or null — see `QuoteView`. */
  convertTrialId: string | null;
  /** Marks the current quote as refused by the panel without a reason. */
  onQuoteRefused: () => void;
}) {
  const { t } = useTranslation();
  const {
    selectedPlan,
    selectedDuration,
    selectedGateway,
    selectedSavedPaymentMethodId,
    savePaymentMethodConsent,
    setCheckoutResult,
    goBack,
  } = usePurchaseStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const leaveWithdrawnPlan = useLeaveWithdrawnPlan();
  const noticeTrialConversion = useNoticeTrialConversion();

  const mutation = useMutation({
    mutationFn: () => {
      const interactiveYookassa =
        selectedGateway?.id === "YOOKASSA" && !selectedSavedPaymentMethodId;
      // On Platega «для автоматического списания» is a subscription the provider
      // runs, and this consent is what tells the panel to create one instead of
      // a one-off payment.
      const providerSubscription =
        selectedGateway?.autopay === true && isProviderSubscriptionGateway(selectedGateway.id);
      if (convertTrialId !== null) {
        // The trial's UPGRADE, paid every way a purchase is: a card charged or
        // saved, or «для автоматического списания» — the panel makes the
        // provider subscription on the conversion, and its later charges renew
        // the converted trial.
        return createUpgradeCheckout(
          selectedPlan!.id,
          selectedDuration!.days,
          selectedGateway!.id,
          convertTrialId,
          selectedSavedPaymentMethodId,
          interactiveYookassa ? savePaymentMethodConsent : undefined,
          interactiveYookassa ? savePaymentMethodConsent : providerSubscription ? true : undefined,
        );
      }
      return createCheckout(
        selectedPlan!.id,
        selectedDuration!.days,
        selectedGateway!.id,
        selectedSavedPaymentMethodId,
        interactiveYookassa ? savePaymentMethodConsent : undefined,
        interactiveYookassa ? savePaymentMethodConsent : providerSubscription ? true : undefined,
        purchaseType,
      );
    },
    onSuccess: (result) => {
      setCheckoutResult(result.paymentId, result.checkoutUrl ?? null);
      // Stash the URL first: `startCheckoutRedirect` cannot navigate inside a
      // Telegram Mini App (no gesture on this path), so the buyer finishes from
      // the button on the return page — and that button needs this URL.
      savePendingCheckout(result.paymentId, result.checkoutUrl ?? null);
      // A converted trial stays the subscription it was; there is no new one for
      // the dashboard to wait for.
      if (convertTrialId === null) {
        saveSubscriptionProvisioningReceipt({
          paymentId: result.paymentId,
          purchaseType,
          slotIndex,
          slotIndexSource,
          phase: "AWAITING_PAYMENT",
        });
      }
      if (result.checkoutUrl) startCheckoutRedirect(result.checkoutUrl);
      // Navigate to payment return to poll status
      navigate(`/payment-return?paymentId=${result.paymentId}`, {
        replace: true,
      });
    },
    onError: (err) => {
      if (isTrialConversionRequiredRefusal(err)) {
        // Back to the quote, which the re-read list turns into the conversion.
        noticeTrialConversion();
        goBack();
        return;
      }
      if (isSubscriptionLimitError(err)) {
        notifySubscriptionLimitReached(t);
        navigate("/dashboard", { replace: true });
        return;
      }
      if (isAutopayNotAvailableRefusal(err)) {
        // Nothing was created. Back to the quote, where «Изменить» leads to the
        // ordinary payment — except when another sign-up for this purchase still
        // waits for the bank: paid beside it, the trial would convert twice, so
        // the buyer is told to finish that one or let it lapse.
        const refusal = autopayRefusalMessage(err);
        toast.error(t(refusal.key, refusal.values));
        goBack();
        return;
      }
      if (isPlanUnavailableRefusal(err)) {
        // The plan was withdrawn after it was picked; nothing was charged.
        // This step never leaves on its own — the latch below forbids a second
        // attempt — so without this the spinner stayed up for good.
        leaveWithdrawnPlan();
        return;
      }
      if (isQuoteNotEligibleRefusal(err)) {
        // Refused without a reason, and nothing was charged. It is not
        // necessarily a withdrawn plan — a paid trial this buyer cannot claim is
        // refused so too, and stays listed — but from a panel that predates
        // PAYMENT_DRAFT_PLAN_NOT_AVAILABLE it may be one. Back to the quote,
        // re-priced (reset, so it cannot decide on the refused copy): its fresh
        // answer names a withdrawal, a trial it will not sell, or a price that
        // stands — and then this quote is marked so Pay is not offered again.
        onQuoteRefused();
        void queryClient.resetQueries({ queryKey: ["quote"] });
        goBack();
        return;
      }
      toast.error(t("purchase.checkout.error"));
      // Back to the quote the buyer confirmed, choices kept: nothing was
      // created, and this step cannot try again by itself (the latch below), so
      // staying here left "creating payment" spinning for good after ANY other
      // failure — a gateway switched off meanwhile, a timeout. From the quote
      // they can pay again or step back to another gateway; the quote is
      // re-priced rather than offered again from the cache.
      void queryClient.invalidateQueries({ queryKey: ["quote"] });
      goBack();
    },
  });

  // A ref, not the mutation flags: StrictMode runs setup → cleanup → setup
  // with no re-render in between, and React Query publishes state through a
  // `setTimeout`, so the second setup still reads `isPending: false` and fires
  // a second draft (two `savePendingCheckout` + `startCheckoutRedirect` +
  // `navigate` runs). Refs survive the simulated remount; this latch does not.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutation.mutate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-muted-foreground">{t("purchase.checkout.creating")}</p>
    </div>
  );
}

export default function PurchasePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { defaultCurrency } = useBranding();
  const { purchasesBlocked } = useAccessMode();
  const {
    step,
    selectedPlan,
    selectedDuration,
    selectedGateway,
    selectDuration,
    selectGateway,
    goBack,
    reset,
  } = usePurchaseStore();
  // The quote (plan, term, gateway) the panel refused at checkout without a
  // reason. Held here because the checkout step that learns it unmounts on the
  // way back to the quote step that has to show it.
  const [refusedQuoteKey, setRefusedQuoteKey] = useState<string | null>(null);

  // Beside a trial the purchase converts it (`lib/trial-conversion`): an UPGRADE
  // of that subscription, which creates none and so takes no slot.
  const { trial, settled: trialKnown } = useTrialToConvert();
  const convertTrialId = trial?.id ?? null;
  const quoteKey = `${String(selectedPlan?.id)}|${String(selectedDuration?.days)}|${String(selectedGateway?.id)}|${String(convertTrialId)}`;

  // Hard capacity gate: never let the wizard complete a NEW/ADDITIONAL buy
  // when the effective multi-sub limit is full (deep-link / stale store).
  const { data: actionPolicy, isFetched: policyFetched } = useQuery({
    queryKey: subscriptionQueryKeys.actionPolicy(),
    queryFn: () => getActionPolicy(),
    staleTime: 15_000,
  });
  // Not before the list is read: until then a trial holder at capacity — every
  // trial holder where multi-subscription is off — would be sent away as "limit
  // reached" from the very purchase that converts their trial.
  const limitReached =
    trialKnown && convertTrialId === null && isSubscriptionLimitReached(actionPolicy);
  const provisioningSlotIndex = actionPolicy?.activeSubscriptionCount ?? 0;
  const provisioningSlotIndexSource: SubscriptionProvisioningSlotIndexSource =
    typeof actionPolicy?.activeSubscriptionCount === "number"
      ? "CHECKOUT"
      : "PAYMENT_STATUS";
  const purchaseType: CreationPurchaseType =
    provisioningSlotIndex > 0 ? "ADDITIONAL" : "NEW";

  // If no plan selected, go back
  useEffect(() => {
    if (!selectedPlan) navigate("/plans", { replace: true });
  }, [selectedPlan, navigate]);

  useEffect(() => {
    if (!policyFetched || !limitReached) return;
    notifySubscriptionLimitReached(t, actionPolicy);
    reset();
    navigate("/dashboard", { replace: true });
  }, [policyFetched, limitReached, actionPolicy, t, reset, navigate]);

  // Access-mode gate: NEW / UPGRADE / ADDITIONAL purchases are blocked
  // under PURCHASE_BLOCKED and RESTRICTED.
  if (purchasesBlocked) {
    return (
      <AccessModeBlockedScreen
        modes={["PURCHASE_BLOCKED", "RESTRICTED"]}
        onBack={() => navigate("/plans")}
      />
    );
  }

  // Block the entire purchase wizard at capacity (server also rejects checkout).
  if (limitReached || !selectedPlan) {
    return null;
  }

  // What this purchase is — a new subscription or the trial's conversion — is
  // not known until the list is read. Usually it is already in the cache.
  if (!trialKnown) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    );
  }

  const steps = ["duration", "gateway", "quote", "checkout"] as const;
  const activeIndex = steps.indexOf(step as (typeof steps)[number]);

  return (
    <div className="pb-8">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-5">
        <button
          onClick={() => {
            // First real step → exit to the plans list; otherwise step back.
            if (step === "duration") {
              reset();
              navigate("/plans");
            } else {
              goBack();
            }
          }}
          aria-label={t("purchase.back")}
          className="glass-icon-btn flex h-9 w-9 items-center justify-center rounded-full"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            {t("purchase.label")}
          </p>
          <h1 className="text-lg font-semibold">{selectedPlan.name}</h1>
        </div>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-2 px-5 mb-6">
        {steps.map((s, i) => (
          <div
            key={s}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors",
              i <= activeIndex ? "bg-(--brand-primary)" : "bg-[color:var(--color-surface-high)]",
            )}
          />
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.2 }}
        >
          {step === "duration" && (
            <SelectDuration plan={selectedPlan} preferredCurrency={defaultCurrency} onSelect={selectDuration} />
          )}
          {step === "gateway" && (
            <SelectGateway onSelect={selectGateway} convertsTrial={convertTrialId !== null} />
          )}
          {step === "quote" && (
            <QuoteView
              purchaseType={purchaseType}
              slotIndex={provisioningSlotIndex}
              slotIndexSource={provisioningSlotIndexSource}
              convertTrialId={convertTrialId}
              refused={refusedQuoteKey === quoteKey}
            />
          )}
          {step === "checkout" && (
            <CheckoutStep
              purchaseType={purchaseType}
              slotIndex={provisioningSlotIndex}
              slotIndexSource={provisioningSlotIndexSource}
              convertTrialId={convertTrialId}
              onQuoteRefused={() => setRefusedQuoteKey(quoteKey)}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
