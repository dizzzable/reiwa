import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowUpCircle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  createUpgradeCheckout,
  getAllSubscriptions,
  getEnabledGateways,
  getQuote,
  getUpgradeOptions,
} from "@/lib/api-client";
import type { UpgradePlanOption } from "@/lib/api-client/subscription";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { useUpgradeStore } from "@/stores/upgrade.store";
import type { GatewayOption } from "@/stores/purchase.store";
import type { Subscription } from "@/types/api";
import { cn } from "@/lib/utils";
import { gatewayLabel } from "@/lib/gateway-display";
import { GatewayIcon } from "@/components/ui/gateway-icon";

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

const CURRENCY_SYMBOLS: Record<string, string> = { RUB: "₽", USD: "$", EUR: "€" };

function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}

export default function UpgradePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { step, reset } = useUpgradeStore();

  useEffect(() => () => reset(), [reset]);

  return (
    <div className="mx-auto max-w-md pb-24 pt-4">
      <div className="flex items-center gap-3 px-5 pb-4">
        <button
          onClick={() => navigate(-1)}
          aria-label={t("upgrade.back")}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-zinc-300 active:scale-95"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t("upgrade.title")}</h1>
        </div>
      </div>

      {step === "subscriptions" && <SelectSubscription />}
      {step === "plan" && <SelectPlan />}
      {step === "duration" && <SelectDuration />}
      {step === "gateway" && <SelectGateway />}
      {step === "review" && <UpgradeReview />}
      {(step === "checkout" || step === "polling") && <CheckoutStep />}
    </div>
  );
}

function SelectSubscription() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectSubscription } = useUpgradeStore();

  const { data, isLoading } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });

  const active = (data?.subscriptions ?? []).filter(
    (s) => s.status === "ACTIVE" || s.status === "LIMITED",
  );

  useEffect(() => {
    if (!isLoading && active.length === 1 && selectedSubscriptionId === null) {
      selectSubscription(active[0]!.id);
    }
  }, [isLoading, active, selectedSubscriptionId, selectSubscription]);

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (active.length === 0) {
    return (
      <div className="px-5">
        <TipCard tone="info">{t("upgrade.noneUpgradeable")}</TipCard>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-zinc-400">{t("upgrade.selectSubtitle")}</p>
      <div className="px-5 space-y-2">
        {active.map((sub) => (
          <button
            key={sub.id}
            onClick={() => selectSubscription(sub.id)}
            className="w-full glass-card flex items-center gap-3 p-4 text-left transition-all hover:border-(--brand-primary)/30 active:scale-[0.98]"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm font-medium text-white">
                {subscriptionTitle(sub)}
              </p>
              {sub.plan?.name && <p className="truncate text-xs text-zinc-500">{sub.plan.name}</p>}
            </div>
            <ArrowUpCircle className="h-5 w-5 shrink-0 text-zinc-500" />
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectPlan() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectPlan, setStep } = useUpgradeStore();

  const { data, isLoading } = useQuery({
    queryKey: ["upgrade-options", selectedSubscriptionId],
    queryFn: () => getUpgradeOptions(selectedSubscriptionId!),
    enabled: !!selectedSubscriptionId,
  });

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  const plans = data?.plans ?? [];
  if (plans.length === 0) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="info">{t("upgrade.noTargets")}</TipCard>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("upgrade.choosePlan")}</h2>
      <div className="px-5 space-y-2">
        {plans.map((plan) => (
          <button
            key={plan.id}
            onClick={() => selectPlan(plan)}
            className="w-full glass-card flex items-center justify-between gap-3 p-4 text-left transition-all hover:border-(--brand-primary)/30 active:scale-[0.98]"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{plan.name}</p>
              <p className="text-xs text-zinc-500">
                {plan.deviceLimit} {t("upgrade.devices")} ·{" "}
                {plan.trafficLimit === null
                  ? t("upgrade.unlimited")
                  : `${plan.trafficLimit} ${t("upgrade.gb")}`}
              </p>
            </div>
            <Check className="h-4 w-4 shrink-0 text-zinc-600" />
          </button>
        ))}
      </div>
      <div className="px-5">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function SelectDuration() {
  const { t } = useTranslation();
  const { selectedPlan, selectDuration, setStep } = useUpgradeStore();
  const durations = selectedPlan?.durations ?? [];

  useEffect(() => {
    if (durations.length === 1) {
      selectDuration(durations[0]!.days);
    }
  }, [durations, selectDuration]);

  if (durations.length === 0) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="danger">{t("upgrade.priceError")}</TipCard>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("plan")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("upgrade.chooseDuration")}</h2>
      <div className="px-5 grid grid-cols-2 gap-3">
        {durations.map((d) => (
          <button
            key={d.id}
            onClick={() => selectDuration(d.days)}
            className="glass-card p-4 text-center transition-all hover:border-(--brand-primary)/30 active:scale-[0.97]"
          >
            <span className="text-sm font-medium text-white">
              {t("purchase.duration.days", { count: d.days })}
            </span>
          </button>
        ))}
      </div>
      <div className="px-5">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("plan")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function SelectGateway() {
  const { t } = useTranslation();
  const { selectGateway, setStep } = useUpgradeStore();
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

  useEffect(() => {
    if (!isLoading && gateways.length === 1) choose(gateways[0]!);
  }, [isLoading, gateways]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {gateways.map((gw) => (
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
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("duration")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function UpgradeReview() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectedPlan, selectedDurationDays, selectedGateway, setStep } =
    useUpgradeStore();

  const { data: quote, isLoading, error } = useQuery({
    queryKey: [
      "upgrade-quote",
      selectedSubscriptionId,
      selectedPlan?.id,
      selectedDurationDays,
      selectedGateway?.id,
    ],
    queryFn: () =>
      getQuote(
        selectedPlan!.id,
        selectedDurationDays!,
        selectedGateway!.id,
        "UPGRADE",
        selectedSubscriptionId!,
      ),
    enabled:
      !!selectedSubscriptionId && !!selectedPlan && !!selectedDurationDays && !!selectedGateway,
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
        <TipCard tone="danger">{t("upgrade.priceError")}</TipCard>
        <StadiumButton fullWidth variant="secondary" onClick={() => setStep("gateway")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    );
  }

  const symbol = CURRENCY_SYMBOLS[quote.currency] ?? "";
  return (
    <div className="px-5 space-y-4">
      <h2 className="text-base font-semibold">{t("upgrade.reviewTitle")}</h2>
      <div className="glass-card divide-y divide-white/6 overflow-hidden">
        <Row label={t("upgrade.newPlan")} value={quote.planName} />
        <Row
          label={t("purchase.quote.duration")}
          value={t("purchase.duration.days", { count: quote.durationDays })}
        />
        <Row label={t("purchase.quote.method")} value={selectedGateway?.label ?? "—"} />
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="font-semibold">{t("upgrade.total")}</span>
          <span className="text-lg font-bold text-(--brand-primary)">
            {symbol}
            {quote.finalPrice.toFixed(2)} {quote.currency}
          </span>
        </div>
      </div>
      <TipCard tone="info">{t("upgrade.resetsExpiry")}</TipCard>
      <StadiumButton
        fullWidth
        size="lg"
        glow
        icon={<Check className="h-5 w-5" />}
        onClick={() => setStep("checkout")}
      >
        {t("upgrade.pay")}
      </StadiumButton>
      <StadiumButton fullWidth variant="ghost" onClick={() => setStep("gateway")}>
        {t("upgrade.change")}
      </StadiumButton>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function CheckoutStep() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { selectedSubscriptionId, selectedPlan, selectedDurationDays, selectedGateway, setCheckoutResult } =
    useUpgradeStore();

  const mutation = useMutation({
    mutationFn: () =>
      createUpgradeCheckout(
        selectedPlan!.id,
        selectedDurationDays!,
        selectedGateway!.id,
        selectedSubscriptionId!,
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
    onError: () => toast.error(t("upgrade.checkoutError")),
  });

  useEffect(() => {
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-zinc-400">{t("upgrade.creating")}</p>
    </div>
  );
}
