import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  activatePromocode,
  createRenewalCheckout,
  getAllSubscriptions,
  getEnabledGateways,
  getPartnerInfo,
  getRenewalOptions,
  payWithPartnerBalance,
} from "@/lib/api-client";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { PromoInput } from "@/features/purchase/components/promo-input";
import { useRenewalStore } from "@/stores/renewal.store";
import type { GatewayOption } from "@/stores/purchase.store";
import type { RenewalOptionItem, Subscription } from "@/types/api";
import { gatewayLabel } from "@/lib/gateway-display";
import { GatewayIcon } from "@/components/ui/gateway-icon";
import { SubscriptionSelectCard } from "@/components/subscription/subscription-select-card";
import { StepTransition } from "@/components/ui/step-transition";
import { BackButton } from "@/components/ui/back-button";
import { useAccessMode } from "@/lib/use-access-mode";
import { AccessModeBlockedScreen } from "@/components/access-mode-banner";

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

const CURRENCY_SYMBOLS: Record<string, string> = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
};

function formatPrice(amount: string | null, currency: string | null): string {
  if (amount === null || currency === null) return "—";
  const symbol = CURRENCY_SYMBOLS[currency] ?? "";
  return `${symbol}${Number(amount).toFixed(2)} ${currency}`;
}

/** Subscription identity as shown on the dashboard card (profile first). */
function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}

export default function RenewalPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { step, reset } = useRenewalStore();
  const { restricted } = useAccessMode();

  // Always start the wizard fresh on mount.
  useEffect(() => {
    return () => reset();
  }, [reset]);

  // Renewal stays OPEN under PURCHASE_BLOCKED (so users keep their VPN); only
  // the emergency RESTRICTED freeze blocks it.
  if (restricted) {
    return (
      <AccessModeBlockedScreen modes={["RESTRICTED"]} onBack={() => navigate("/dashboard")} />
    );
  }

  return (
    <div className="mx-auto max-w-md pb-24 pt-4">
      <div className="flex items-center gap-3 px-5 pb-4">
        <BackButton fallback="/dashboard" label={t("renewal.back")} />
        <div className="flex items-center gap-2">
          <RotateCcw className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t("renewal.title")}</h1>
        </div>
      </div>

      <StepTransition stepKey={step}>
        {step === "subscriptions" && <SelectSubscriptions />}
        {step === "gateway" && <SelectGateway />}
        {step === "review" && <RenewalReview />}
        {step === "checkout" && <CheckoutStep />}
        {step === "polling" && <CheckoutStep />}
      </StepTransition>
    </div>
  );
}

function SelectSubscriptions() {
  const { t } = useTranslation();
  const {
    selectedSubscriptionIds,
    selectedDurations,
    toggleSubscription,
    setSelectedSubscriptions,
    setSelectedDuration,
    setStep,
  } = useRenewalStore();

  const durationsPayload = Object.entries(selectedDurations).map(([subscriptionId, days]) => ({
    subscriptionId,
    days,
  }));

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ["renewal-options", selectedDurations],
    queryFn: () =>
      getRenewalOptions(durationsPayload.length > 0 ? { durations: durationsPayload } : undefined),
    staleTime: 60_000,
  });
  const { data: subsData, isLoading: subsLoading } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const isLoading = optionsLoading || subsLoading;

  // Merge: the user's own subscriptions (card identity) + per-item renewal
  // price. We renew the subscriptions the user already owns — the plan/tariff
  // is implicit, so the list shows subscriptions, not plans.
  const optionById = new Map((options?.items ?? []).map((o) => [o.subscriptionId, o]));
  const renewable = (subsData?.subscriptions ?? [])
    .map((sub) => ({ sub, option: optionById.get(sub.id) }))
    .filter(
      (row): row is { sub: Subscription; option: RenewalOptionItem } =>
        row.option !== undefined && row.option.renewable,
    );

  // Skip the selection step entirely when there is exactly one renewable
  // subscription — auto-select it and advance to the gateway step.
  useEffect(() => {
    if (!isLoading && renewable.length === 1 && selectedSubscriptionIds.length === 0) {
      setSelectedSubscriptions([renewable[0]!.sub.id]);
      setStep("gateway");
    }
  }, [isLoading, renewable, selectedSubscriptionIds.length, setSelectedSubscriptions, setStep]);

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (renewable.length === 0) {
    return (
      <div className="px-5">
        <TipCard tone="info">{t("renewal.noneRenewable")}</TipCard>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-zinc-400">{t("renewal.selectSubtitle")}</p>
      <div className="px-5 space-y-2">
        {renewable.map(({ sub, option }) => {
          const checked = selectedSubscriptionIds.includes(sub.id);
          const planLabel = sub.plan?.name ?? option.planName ?? "";
          const currentDays = selectedDurations[sub.id] ?? option.durationDays;
          const durationLabel = currentDays
            ? t("purchase.duration.days", { count: currentDays })
            : "";
          const subtitle = [planLabel, durationLabel].filter(Boolean).join(" · ");
          const showDurationPicker = option.availableDurations.length > 1;
          return (
            <div key={sub.id} className="space-y-2">
              <SubscriptionSelectCard
                subscription={sub}
                selected={checked}
                onSelect={() => toggleSubscription(sub.id)}
                control="check"
                subtitle={subtitle}
                trailing={
                  <span className="text-sm font-semibold text-(--brand-primary)">
                    {formatPrice(option.amount, option.currency)}
                  </span>
                }
              />
              {showDurationPicker && (
                <div className="px-1">
                  <p className="mb-1.5 text-xs text-zinc-500">{t("renewal.durationLabel")}</p>
                  <div className="flex flex-wrap gap-2">
                    {option.availableDurations.map((d) => {
                      const active = currentDays === d.days;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setSelectedDuration(sub.id, d.days)}
                          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all active:scale-95 ${
                            active
                              ? "bg-(--brand-primary) text-black"
                              : "bg-white/5 text-zinc-300 hover:bg-white/10"
                          }`}
                        >
                          {t("purchase.duration.days", { count: d.days })}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-5 pt-2">
        <StadiumButton
          fullWidth
          size="lg"
          glow
          disabled={selectedSubscriptionIds.length === 0}
          onClick={() => setStep("gateway")}
        >
          {t("renewal.continue")}
        </StadiumButton>
      </div>
    </div>
  );
}

function SelectGateway() {
  const { t } = useTranslation();
  const { selectGateway, setStep } = useRenewalStore();
  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });

  const choose = (gw: { type: string; displayName: string; currency: string }): void =>
    selectGateway({
      id: gw.type,
      label: gatewayLabel(gw.type, gw.displayName),
      icon: GATEWAY_ICONS[gw.type] ?? "💳",
      currency: gw.currency,
    } satisfies GatewayOption);

  // Auto-select when a single gateway is available.
  useEffect(() => {
    if (!isLoading && gateways.length === 1) {
      choose(gateways[0]!);
    }
  }, [isLoading, gateways]); // eslint-disable-line react-hooks/exhaustive-deps

  const isTma = !!window.Telegram?.WebApp?.initData;
  const sorted = [...gateways].sort((a, b) => {
    if (isTma) {
      if (a.type === "TELEGRAM_STARS") return -1;
      if (b.type === "TELEGRAM_STARS") return 1;
    }
    return 0;
  });

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("purchase.gateway.title")}</h2>
      <div className="px-5 space-y-2">
        {sorted.map((gw) => (
          <button
            key={gw.type}
            onClick={() => choose(gw)}
            className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
          >
            <GatewayIcon type={gw.type} currency={gw.currency} className="h-7 w-7" />
            <div className="text-left">
              <p className="font-medium text-white">{gatewayLabel(gw.type, gw.displayName)}</p>
              <p className="text-xs text-zinc-500">{gw.currency}</p>
            </div>
          </button>
        ))}
        {gateways.length === 0 && (
          <div className="text-center py-8 text-zinc-500 text-sm">{t("purchase.gateway.empty")}</div>
        )}
      </div>
      <div className="px-5">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("renewal.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function RenewalReview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedSubscriptionIds, selectedDurations, selectedGateway, setStep } =
    useRenewalStore();

  const durationsPayload = selectedSubscriptionIds
    .filter((id) => selectedDurations[id] !== undefined)
    .map((id) => ({ subscriptionId: id, days: selectedDurations[id]! }));

  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["renewal-review", selectedSubscriptionIds, selectedGateway?.id, selectedDurations],
    queryFn: () =>
      getRenewalOptions({
        subscriptionIds: selectedSubscriptionIds,
        gatewayType: selectedGateway!.id,
        ...(durationsPayload.length > 0 ? { durations: durationsPayload } : {}),
      }),
    enabled: selectedSubscriptionIds.length > 0 && !!selectedGateway,
  });
  const { data: subsData } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const subById = new Map((subsData?.subscriptions ?? []).map((s) => [s.id, s]));

  const { data: partner } = useQuery({
    queryKey: ["partner", "info"],
    queryFn: getPartnerInfo,
    staleTime: 60_000,
  });
  const balanceMutation = useMutation({
    mutationFn: (item: RenewalOptionItem) =>
      payWithPartnerBalance({
        purchaseType: "RENEW",
        planId: String(item.planId),
        durationDays: item.durationDays ?? 0,
        subscriptionId: item.subscriptionId,
      }),
    onSuccess: () => {
      toast.success(t("renewal.balancePaid"));
      void queryClient.invalidateQueries({ queryKey: ["subscriptions", "all"] });
      void queryClient.invalidateQueries({ queryKey: ["subscriptions-all"] });
      void queryClient.invalidateQueries({ queryKey: ["partner", "info"] });
      navigate("/dashboard", { replace: true });
    },
    onError: () => toast.error(t("renewal.balanceError")),
  });

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    );
  }

  const items: RenewalOptionItem[] = (data?.items ?? []).filter((i) =>
    selectedSubscriptionIds.includes(i.subscriptionId),
  );
  const priceError = error || !data || data.total === null || items.some((i) => !i.renewable);
  // Partner-balance pay is offered only for a single-subscription renewal whose
  // priced currency matches the partner balance currency and is covered by it.
  const balanceItem =
    items.length === 1 && items[0]!.planId !== null && items[0]!.durationDays !== null
      ? items[0]!
      : null;
  const balanceEligible =
    balanceItem !== null &&
    !!partner &&
    partner.isActive &&
    partner.balancePaymentEnabled &&
    partner.balanceCurrency === balanceItem.currency &&
    balanceItem.amount !== null &&
    partner.balance >= Math.round(Number(balanceItem.amount) * 100);

  if (priceError) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="danger">{t("renewal.priceError")}</TipCard>
        <StadiumButton fullWidth variant="secondary" onClick={() => setStep("gateway")}>
          {t("renewal.back")}
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="px-5 space-y-4">
      <h2 className="text-base font-semibold">{t("renewal.reviewTitle")}</h2>

      <div className="glass-card divide-y divide-white/6 overflow-hidden">
        {items.map((item) => {
          const sub = subById.get(item.subscriptionId);
          const title = sub ? subscriptionTitle(sub) : (item.planName ?? t("renewal.unknownPlan"));
          const planLabel = sub?.plan?.name ?? item.planName ?? "";
          const durationLabel = item.durationDays
            ? t("purchase.duration.days", { count: item.durationDays })
            : "";
          const subtitle = [planLabel, durationLabel].filter(Boolean).join(" · ");
          return (
            <div
              key={item.subscriptionId}
              className="flex items-center justify-between px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-mono font-medium text-white">{title}</p>
                {subtitle && <p className="truncate text-xs text-zinc-500">{subtitle}</p>}
              </div>
              <span className="shrink-0 font-medium">
                {formatPrice(item.amount, item.currency)}
              </span>
            </div>
          );
        })}
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="font-semibold">{t("renewal.total")}</span>
          <span className="text-lg font-bold text-(--brand-primary)">
            {formatPrice(data!.total, data!.currency)}
          </span>
        </div>
      </div>

      <PromoInput
        onPromoApplied={(code) => {
          if (code) {
            void queryClient.invalidateQueries({ queryKey: ["renewal-review"] });
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

      <StadiumButton
        fullWidth
        size="lg"
        glow
        icon={<Check className="h-5 w-5" />}
        onClick={() => setStep("checkout")}
      >
        {t("renewal.pay")}
      </StadiumButton>
      {balanceEligible && balanceItem && partner && (
        <StadiumButton
          fullWidth
          variant="secondary"
          loading={balanceMutation.isPending}
          onClick={() => balanceMutation.mutate(balanceItem)}
        >
          {t("renewal.payWithBalance", {
            amount: (partner.balance / 100).toFixed(2),
            currency: partner.balanceCurrency,
          })}
        </StadiumButton>
      )}
      <StadiumButton fullWidth variant="ghost" onClick={() => navigate("/dashboard")}>
        {t("renewal.home")}
      </StadiumButton>
    </div>
  );
}

function CheckoutStep() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { selectedSubscriptionIds, selectedDurations, selectedGateway, setCheckoutResult } =
    useRenewalStore();

  const durationsPayload = selectedSubscriptionIds
    .filter((id) => selectedDurations[id] !== undefined)
    .map((id) => ({ subscriptionId: id, days: selectedDurations[id]! }));

  const mutation = useMutation({
    mutationFn: () =>
      createRenewalCheckout(
        selectedSubscriptionIds,
        selectedGateway!.id,
        durationsPayload.length > 0 ? durationsPayload : undefined,
      ),
    onSuccess: (result) => {
      setCheckoutResult(result.paymentId, result.checkoutUrl ?? null);
      const tg = window.Telegram?.WebApp;
      if (result.checkoutUrl) {
        if (tg) tg.openLink(result.checkoutUrl);
        else window.open(result.checkoutUrl, "_blank");
      }
      navigate(`/payment-return?paymentId=${result.paymentId}`, { replace: true });
    },
    onError: () => toast.error(t("renewal.checkoutError")),
  });

  useEffect(() => {
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-zinc-400">{t("renewal.creating")}</p>
    </div>
  );
}
