/**
 * AddOnsPage — full-screen add-on purchase wizard.
 * ────────────────────────────────────────────────
 * Replaces the old centered modal so buying extra traffic / devices reads like
 * the renewal flow:
 *   1. Pick the target subscription (skipped when the user has only one).
 *   2. Pick an add-on applicable to that subscription's plan.
 *   3. Pick a payment gateway (skipped for free add-ons — applied instantly).
 *   4. Checkout → provider redirect, or instant success for free add-ons.
 */
import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Gauge, Plus, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  getAllSubscriptions,
  getEnabledGateways,
  getPlanAddOns,
  purchaseAddOn,
  type AddOn,
} from "@/lib/api-client";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { GatewayIcon } from "@/components/ui/gateway-icon";
import { gatewayLabel } from "@/lib/gateway-display";
import { SubscriptionSelectCard } from "@/components/subscription/subscription-select-card";
import { StepTransition } from "@/components/ui/step-transition";
import { BackButton } from "@/components/ui/back-button";
import { useBranding } from "@/lib/branding-provider";
import { customIconId, isEmojiIcon, resolveBuiltInIcon } from "@/features/plans/plan-icons";
import { CustomIconView } from "@/components/ui/custom-icon-view";
import { EmojiText } from "@/components/ui/emoji-text";
import { useAddOnStore } from "@/stores/addons.store";
import { useAccessMode } from "@/lib/use-access-mode";
import { AccessModeBlockedScreen } from "@/components/access-mode-banner";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

/** All configured prices are zero → the add-on is granted without a checkout. */
function isFree(addOn: AddOn): boolean {
  return addOn.prices.length > 0 && addOn.prices.every((p) => Number(p.price) === 0);
}

export default function AddOnsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { step, reset } = useAddOnStore();
  const { purchasesBlocked } = useAccessMode();

  useEffect(() => () => reset(), [reset]);

  // Add-on purchase is a new money-path flow — blocked under
  // PURCHASE_BLOCKED / RESTRICTED.
  if (purchasesBlocked) {
    return (
      <AccessModeBlockedScreen
        modes={["PURCHASE_BLOCKED", "RESTRICTED"]}
        onBack={() => navigate("/dashboard")}
      />
    );
  }

  return (
    <div className="mx-auto max-w-md pb-24 pt-4">
      <div className="flex items-center gap-3 px-5 pb-4">
        <BackButton fallback="/dashboard" label={t("addons.back")} />
        <div className="flex items-center gap-2">
          <Plus className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t("addons.title")}</h1>
        </div>
      </div>

      <StepTransition stepKey={step}>
        {step === "subscriptions" && <SelectSubscription />}
        {step === "addon" && <SelectAddOn />}
        {step === "gateway" && <SelectGateway />}
        {step === "checkout" && <CheckoutStep />}
      </StepTransition>
    </div>
  );
}

function SelectSubscription() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectSubscription } = useAddOnStore();

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
        <TipCard tone="info">{t("addons.noneActive")}</TipCard>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-zinc-400">{t("addons.selectSubtitle")}</p>
      <div className="px-5 space-y-2">
        {active.map((sub) => (
          <SubscriptionSelectCard
            key={sub.id}
            subscription={sub}
            selected={sub.id === selectedSubscriptionId}
            onSelect={() => selectSubscription(sub.id)}
            control="radio"
            subtitle={sub.plan?.name ?? undefined}
          />
        ))}
      </div>
    </div>
  );
}

function SelectAddOn() {
  const { t } = useTranslation();
  const { customIcons } = useBranding();
  const { selectedSubscriptionId, selectAddOn, selectGateway, setStep } = useAddOnStore();

  const { data: subsData } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const sub = (subsData?.subscriptions ?? []).find((s) => s.id === selectedSubscriptionId) ?? null;
  const planId = sub?.plan?.id ?? null;
  const isUnlimitedTraffic = sub?.trafficLimit === null;

  const { data: addOns, isLoading } = useQuery({
    queryKey: ["add-ons", planId],
    queryFn: () => getPlanAddOns(planId ?? ""),
    enabled: planId !== null,
    staleTime: 60_000,
  });
  const { data: gateways = [] } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });

  const visible = (addOns ?? []).filter(
    (a) => !(isUnlimitedTraffic && a.type === "EXTRA_TRAFFIC"),
  );

  const onPick = (addOn: AddOn) => {
    // Free add-on: skip gateway selection, jump to checkout with a gateway
    // whose currency carries the zero-priced row (any active one otherwise).
    if (isFree(addOn)) {
      const freeGw =
        gateways.find((gw) =>
          addOn.prices.some((p) => p.currency === gw.currency && Number(p.price) === 0),
        ) ?? gateways[0];
      if (freeGw) {
        selectAddOn(addOn);
        selectGateway({
          id: freeGw.type,
          label: gatewayLabel(freeGw.type, freeGw.displayName),
          icon: "💳",
          currency: freeGw.currency,
        });
        return;
      }
    }
    selectAddOn(addOn);
  };

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="info">{t("addons.empty")}</TipCard>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-muted-foreground">{t("addons.description")}</p>
      <div className="px-5 space-y-2">
        {visible.map((addOn) => {
          const price = addOn.prices[0];
          const free = isFree(addOn);
          const customId = customIconId(addOn.icon);
          const custom = customId ? customIcons.find((c) => c.id === customId) : undefined;
          const BuiltIn = resolveBuiltInIcon(addOn.icon);
          const TypeFallback = addOn.type === "EXTRA_TRAFFIC" ? Gauge : Smartphone;
          return (
            <button
              key={addOn.id}
              onClick={() => onPick(addOn)}
              className="flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/3 p-4 text-left transition-colors hover:bg-white/6 active:scale-[0.98]"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-(--brand-primary)">
                {isEmojiIcon(addOn.icon) ? (
                  <EmojiText text={addOn.icon} className="text-xl leading-none" />
                ) : custom ? (
                  <CustomIconView url={custom.url} color={custom.color} className="h-5 w-5" />
                ) : BuiltIn ? (
                  <BuiltIn className="h-5 w-5" />
                ) : (
                  <TypeFallback className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">{addOn.name}</p>
                <p className="text-xs text-zinc-500">
                  {addOn.type === "EXTRA_TRAFFIC"
                    ? t("addons.extraTraffic", { value: addOn.value })
                    : t("addons.extraDevices", { value: addOn.value })}
                </p>
              </div>
              {price && (
                <span className="shrink-0 text-sm font-semibold text-(--brand-primary)">
                  {free
                    ? t("addons.free")
                    : `${CURRENCY_SYMBOLS[price.currency] ?? ""}${Number(price.price).toFixed(2)}`}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="px-5 pt-2">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function SelectGateway() {
  const { t } = useTranslation();
  const { selectedAddOn, selectGateway, setStep } = useAddOnStore();

  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });

  const choose = (gw: { type: string; displayName: string; currency: string }) =>
    selectGateway({
      id: gw.type,
      label: gatewayLabel(gw.type, gw.displayName),
      icon: "💳",
      currency: gw.currency,
    });

  useEffect(() => {
    if (!isLoading && gateways.length === 1) choose(gateways[0]!);
  }, [isLoading, gateways]); // eslint-disable-line react-hooks/exhaustive-deps

  const isTma = !!window.Telegram?.WebApp?.initData;
  const sorted = useMemo(
    () =>
      [...gateways].sort((a, b) => {
        if (isTma) {
          if (a.type === "TELEGRAM_STARS") return -1;
          if (b.type === "TELEGRAM_STARS") return 1;
        }
        return 0;
      }),
    [gateways, isTma],
  );

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
      <h2 className="px-5 text-base font-semibold">{t("addons.selectGateway")}</h2>
      {selectedAddOn && (
        <p className="px-5 text-sm text-zinc-400">{selectedAddOn.name}</p>
      )}
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
          <div className="py-8 text-center text-sm text-zinc-500">{t("purchase.gateway.empty")}</div>
        )}
      </div>
      <div className="px-5">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("addon")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function CheckoutStep() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedSubscriptionId, selectedAddOn, selectedGateway } = useAddOnStore();

  const mutation = useMutation({
    mutationFn: () =>
      purchaseAddOn({
        addOnId: selectedAddOn!.id,
        subscriptionId: selectedSubscriptionId!,
        gatewayType: selectedGateway!.id,
      }),
    onSuccess: (result) => {
      if (result.checkoutUrl) {
        const tg = window.Telegram?.WebApp;
        if (tg) tg.openLink(result.checkoutUrl);
        else window.open(result.checkoutUrl, "_blank");
        navigate(`/payment-return?paymentId=${result.paymentId}`, { replace: true });
      } else {
        // Free add-on: applied instantly server-side, no redirect.
        toast.success(t("addons.freeApplied"));
        void queryClient.invalidateQueries({ queryKey: ["subscriptions-all"] });
        void queryClient.invalidateQueries({ queryKey: ["devices"] });
        navigate("/dashboard", { replace: true });
      }
    },
    onError: () => {
      toast.error(t("addons.purchaseError"));
      navigate("/dashboard", { replace: true });
    },
  });

  useEffect(() => {
    if (!selectedAddOn || !selectedSubscriptionId || !selectedGateway) {
      navigate("/dashboard", { replace: true });
      return;
    }
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-zinc-400">{t("addons.creating")}</p>
    </div>
  );
}
