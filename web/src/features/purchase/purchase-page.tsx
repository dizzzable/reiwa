import { useEffect, type ComponentType, type SVGProps } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, Check, CreditCard } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getActionPolicy,
  getQuote,
  createCheckout,
  getEnabledGateways,
  activatePromocode,
  getPaymentMethods,
  type CreationPurchaseType,
} from "@/lib/api-client";
import { getPartnerInfo, payWithPartnerBalance } from "@/lib/api-client";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { Switch } from "@/components/ui/switch";
import { AppleGlyph, AndroidGlyph, WindowsGlyph, MacosGlyph } from "@/components/ui/device-glyphs";
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
import type { GatewayOption, DeviceTypeOption } from "@/stores/purchase.store";
import type { Plan, PlanDuration } from "@/types/api";
import { cn, openExternalUrl } from "@/lib/utils";
import { gatewayLabel } from "@/lib/gateway-display";
import { GatewayIcon } from "@/components/ui/gateway-icon";
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

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

function SelectDuration({
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
  // device step re-mounts this and immediately re-advances (a trap).
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
          return (
            <button
              key={dur.id}
              onClick={() => onSelect(dur)}
              className="w-full glass-card p-4 flex items-center justify-between hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
            >
              <div className="text-left">
                <p className="font-medium text-white">
                  {t("purchase.duration.days", { count: dur.days })}
                </p>
                <p className="text-xs text-zinc-500">
                  {dur.days >= 365
                    ? t("purchase.duration.year")
                    : dur.days >= 30
                      ? t("purchase.duration.months", { count: Math.round(dur.days / 30) })
                      : t("purchase.duration.days", { count: dur.days })}
                </p>
              </div>
              {displayPrice && (() => {
                const hasDiscount =
                  (displayPrice.discountPercent ?? 0) > 0 &&
                  displayPrice.discountSource !== undefined &&
                  displayPrice.discountSource !== "NONE" &&
                  displayPrice.originalPrice !== undefined;
                const sym = CURRENCY_SYMBOLS[displayPrice.currency] ?? "";
                return (
                  <div className="flex flex-col items-end gap-0.5">
                    {hasDiscount && (
                      <div className="flex items-center gap-1.5">
                        <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-400/30">
                          −{displayPrice.discountPercent}%
                        </span>
                        <span className="text-[11px] text-zinc-500 line-through">
                          {sym}
                          {Number(displayPrice.originalPrice).toFixed(2)}
                        </span>
                      </div>
                    )}
                    <p className="text-(--brand-primary) font-semibold">
                      {sym}
                      {Number(displayPrice.price).toFixed(2)}
                    </p>
                  </div>
                );
              })()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const DEVICE_OPTIONS: ReadonlyArray<{
  id: DeviceTypeOption;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  labelKey: string;
}> = [
  { id: "IPHONE", Icon: AppleGlyph, labelKey: "purchase.device.iphone" },
  { id: "ANDROID", Icon: AndroidGlyph, labelKey: "purchase.device.android" },
  { id: "WINDOWS", Icon: WindowsGlyph, labelKey: "purchase.device.windows" },
  { id: "MAC", Icon: MacosGlyph, labelKey: "purchase.device.mac" },
];

function SelectDevice({ onSelect }: { onSelect: (d: DeviceTypeOption) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("purchase.device.title")}</h2>
      <p className="px-5 -mt-2 text-xs text-zinc-500">{t("purchase.device.subtitle")}</p>
      <div className="px-5 grid grid-cols-2 gap-3">
        {DEVICE_OPTIONS.map(({ id, Icon, labelKey }) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className="glass-card flex flex-col items-center gap-3 p-5 ring-1 ring-white/5 hover:ring-(--brand-primary)/30 hover:bg-(--brand-primary)/4 active:scale-[0.97] transition-all"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur-sm text-(--brand-primary)">
              <Icon className="h-6 w-6" />
            </span>
            <span className="text-sm font-medium text-white">{t(labelKey)}</span>
          </button>
        ))}
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
}: {
  onSelect: (gw: GatewayOption) => void;
}) {
  const { t } = useTranslation();
  const lastNav = usePurchaseStore((s) => s.lastNav);
  const selectedGateway = usePurchaseStore((s) => s.selectedGateway);
  const selectedSavedPaymentMethodId = usePurchaseStore((s) => s.selectedSavedPaymentMethodId);
  const selectSavedPaymentMethod = usePurchaseStore((s) => s.selectSavedPaymentMethod);
  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });
  const yookassaEnabled = gateways.some((gw) => gw.type === "YOOKASSA" && gw.isActive !== false);
  const { data: paymentMethodsData } = useQuery({
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
  useEffect(() => {
    if (!isLoading && gateways.length === 1 && lastNav === "forward") {
      const gw = gateways[0];
      onSelect({
        id: gw.type,
        label: gatewayLabel(gw.type, gw.displayName),
        icon: GATEWAY_ICONS[gw.type] ?? "💳",
        currency: gw.currency,
      });
    }
  }, [isLoading, gateways, lastNav]); // eslint-disable-line react-hooks/exhaustive-deps

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
            className="h-16 animate-pulse rounded-2xl bg-zinc-800/50"
          />
        ))}
      </div>
    );

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("purchase.gateway.title")}</h2>
      {savedYookassaMethods.length > 0 && (
        <div className="px-5 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
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
                  <p className="truncate font-medium text-white">
                    {formatSavedPaymentMethodTitle(method, t)}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {formatSavedPaymentMethodMeta(method, t)}
                  </p>
                </div>
                {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-(--brand-primary)" />}
              </button>
            );
          })}
          <button
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
              queueMicrotask(() => selectSavedPaymentMethod(null));
            }}
            className={cn(
              "w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all",
              selectedGateway?.id === "YOOKASSA" &&
                selectedSavedPaymentMethodId === null &&
                "border-(--brand-primary)/40 bg-(--brand-primary)/5",
            )}
          >
            <span className="flex h-7 w-7 items-center justify-center text-2xl">
              <GatewayIcon type="YOOKASSA" currency="RUB" className="h-7 w-7" />
            </span>
            <div className="text-left">
              <p className="font-medium text-white">{t("purchase.gateway.newCard")}</p>
              <p className="text-xs text-zinc-500">YooKassa</p>
            </div>
          </button>
        </div>
      )}
      <div className="px-5 space-y-2">
        {sortedGateways
          .filter((gw) => !(savedYookassaMethods.length > 0 && gw.type === "YOOKASSA"))
          .map((gw) => (
          <button
            key={gw.type}
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
              <p className="font-medium text-white">{gatewayLabel(gw.type, gw.displayName)}</p>
              <p className="text-xs text-zinc-500">{gw.currency}</p>
            </div>
          </button>
        ))}
        {gateways.length === 0 && (
          <div className="text-center py-8 text-zinc-500 text-sm">
            {t("purchase.gateway.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

function QuoteView({
  purchaseType,
  slotIndex,
  slotIndexSource,
}: {
  purchaseType: CreationPurchaseType;
  slotIndex: number;
  slotIndexSource: SubscriptionProvisioningSlotIndexSource;
}) {
  const { t } = useTranslation();
  const {
    selectedPlan,
    selectedDuration,
    selectedGateway,
    selectedDevice,
    selectedSavedPaymentMethodId,
    savePaymentMethodConsent,
    setSavePaymentMethodConsent,
    setQuote,
    goBack,
  } = usePurchaseStore();
  const showSaveCardConsent =
    selectedGateway?.id === "YOOKASSA" && !selectedSavedPaymentMethodId;
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

  const deviceLabel = selectedDevice
    ? t(`purchase.device.${selectedDevice.toLowerCase()}`)
    : null;

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
    ],
    queryFn: () =>
      getQuote(selectedPlan!.id, selectedDuration!.days, selectedGateway!.id),
    enabled: !!(selectedPlan && selectedDuration && selectedGateway),
  });

  const balanceMutation = useMutation({
    mutationFn: async () => {
      const result = await payWithPartnerBalance({
        purchaseType,
        planId: String(selectedPlan!.id),
        durationDays: selectedDuration!.days,
        deviceType: selectedDevice ?? undefined,
      });
      if (!result.paymentId) {
        throw new Error("Partner balance payment did not return a paymentId");
      }
      return { ...result, paymentId: result.paymentId };
    },
    onSuccess: (result) => {
      saveSubscriptionProvisioningReceipt({
        paymentId: result.paymentId,
        purchaseType,
        slotIndex,
        slotIndexSource,
        phase: "PROVISIONING",
      });
      toast.success(t("purchase.quote.balancePaid"));
      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.all,
      });
      void queryClient.invalidateQueries({ queryKey: ["action-policy"] });
      void queryClient.invalidateQueries({ queryKey: ["partner", "info"] });
      navigate("/dashboard", { replace: true });
    },
    onError: (err) => {
      if (isSubscriptionLimitError(err)) {
        notifySubscriptionLimitReached(t);
        navigate("/dashboard", { replace: true });
        return;
      }
      toast.error(t("purchase.quote.balanceError"));
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
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

      <div className="glass-card divide-y divide-white/[0.06] overflow-hidden">
        <Row label={t("purchase.quote.plan")} value={quote.planName} />
        <Row
          label={t("purchase.quote.duration")}
          value={t("purchase.duration.days", { count: quote.durationDays })}
        />
        {deviceLabel && <Row label={t("purchase.quote.device")} value={deviceLabel} />}
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

      {showSaveCardConsent && (
        <div className="flex items-start justify-between gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
          <div className="min-w-0 text-zinc-300 leading-snug">
            <p className="font-medium text-zinc-100">{t("purchase.quote.saveCardTitle")}</p>
            <p id="purchase-save-card-hint" className="mt-0.5 text-xs text-zinc-400">
              {t("purchase.quote.saveCardHint")}
            </p>
          </div>
          <Switch
            className="mt-0.5"
            checked={savePaymentMethodConsent}
            onCheckedChange={setSavePaymentMethodConsent}
            aria-label={t("purchase.quote.saveCardTitle")}
            aria-describedby="purchase-save-card-hint"
          />
        </div>
      )}

      <StadiumButton
        fullWidth
        size="lg"
        onClick={() => setQuote(quote)}
        glow
        icon={<Check className="h-5 w-5" />}
      >
        {t("purchase.quote.pay")}
      </StadiumButton>
      {partner &&
        partner.isActive &&
        partner.balancePaymentEnabled &&
        partner.balanceCurrency === quote.currency &&
        partner.balance >= Math.round(quote.finalPrice * 100) && (
          <StadiumButton
            fullWidth
            variant="secondary"
            loading={balanceMutation.isPending}
            onClick={() => balanceMutation.mutate()}
          >
            {t("purchase.quote.payWithBalance", {
              amount: (partner.balance / 100).toFixed(2),
              currency: partner.balanceCurrency,
            })}
          </StadiumButton>
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
      <span className="text-zinc-400">{label}</span>
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
}: {
  purchaseType: CreationPurchaseType;
  slotIndex: number;
  slotIndexSource: SubscriptionProvisioningSlotIndexSource;
}) {
  const { t } = useTranslation();
  const {
    selectedPlan,
    selectedDuration,
    selectedGateway,
    selectedDevice,
    selectedSavedPaymentMethodId,
    savePaymentMethodConsent,
    setCheckoutResult,
  } = usePurchaseStore();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => {
      const interactiveYookassa =
        selectedGateway?.id === "YOOKASSA" && !selectedSavedPaymentMethodId;
      return createCheckout(
        selectedPlan!.id,
        selectedDuration!.days,
        selectedGateway!.id,
        selectedDevice ?? undefined,
        selectedSavedPaymentMethodId,
        interactiveYookassa ? savePaymentMethodConsent : undefined,
        interactiveYookassa ? savePaymentMethodConsent : undefined,
        purchaseType,
      );
    },
    onSuccess: (result) => {
      setCheckoutResult(result.paymentId, result.checkoutUrl ?? null);
      // Stash the URL so the return page can offer a manual "open payment"
      // button. `checkoutUrl` can be null for non-redirect flows (e.g. Telegram
      // Stars) — then we skip opening and just poll status on the return page.
      // The auto-open below is blocked on Telegram Desktop (openLink must run
      // inside a user gesture, which this async onSuccess has already lost), so
      // the return-page button is the reliable path there.
      savePendingCheckout(result.paymentId, result.checkoutUrl ?? null);
      saveSubscriptionProvisioningReceipt({
        paymentId: result.paymentId,
        purchaseType,
        slotIndex,
        slotIndexSource,
        phase: "AWAITING_PAYMENT",
      });
      if (result.checkoutUrl) openExternalUrl(result.checkoutUrl);
      // Navigate to payment return to poll status
      navigate(`/payment-return?paymentId=${result.paymentId}`, {
        replace: true,
      });
    },
    onError: (err) => {
      if (isSubscriptionLimitError(err)) {
        notifySubscriptionLimitReached(t);
        navigate("/dashboard", { replace: true });
        return;
      }
      toast.error(t("purchase.checkout.error"));
    },
  });

  useEffect(() => {
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-zinc-400">{t("purchase.checkout.creating")}</p>
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
    selectDuration,
    selectDevice,
    selectGateway,
    goBack,
    reset,
  } = usePurchaseStore();

  // Hard capacity gate: never let the wizard complete a NEW/ADDITIONAL buy
  // when the effective multi-sub limit is full (deep-link / stale store).
  const { data: actionPolicy, isFetched: policyFetched } = useQuery({
    queryKey: ["action-policy"],
    queryFn: () => getActionPolicy(),
    staleTime: 15_000,
  });
  const limitReached = isSubscriptionLimitReached(actionPolicy);
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

  const steps = ["duration", "device", "gateway", "quote", "checkout"] as const;
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
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wide">
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
              i <= activeIndex ? "bg-(--brand-primary)" : "bg-zinc-800",
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
          {step === "device" && selectedDuration && (
            <SelectDevice onSelect={selectDevice} />
          )}
          {step === "gateway" && <SelectGateway onSelect={selectGateway} />}
          {step === "quote" && (
            <QuoteView
              purchaseType={purchaseType}
              slotIndex={provisioningSlotIndex}
              slotIndexSource={provisioningSlotIndexSource}
            />
          )}
          {step === "checkout" && (
            <CheckoutStep
              purchaseType={purchaseType}
              slotIndex={provisioningSlotIndex}
              slotIndexSource={provisioningSlotIndexSource}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
