import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  activatePromocode,
  createRenewalCheckout,
  getAddOnEntitlements,
  getAllSubscriptions,
  getEnabledGateways,
  getPartnerInfo,
  getPaymentMethods,
  getPlans,
  getRenewalOptions,
  getSubscriptionAddOns,
  payWithPartnerBalance,
} from "@/lib/api-client";
import type { EligibleAddOn } from "@/lib/api-client";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { Switch } from "@/components/ui/switch";
import { PromoInput } from "@/features/purchase/components/promo-input";
import { useRenewalStore } from "@/stores/renewal.store";
import type { GatewayOption } from "@/stores/purchase.store";
import type { RenewalOptionItem, Subscription } from "@/types/api";
import { cn, openExternalUrl } from "@/lib/utils";
import { savePendingCheckout } from "@/lib/pending-checkout";
import { TariffCard } from "@/features/plans/tariff-card";
import { gatewayLabel } from "@/lib/gateway-display";
import { createRenewalIdempotencyKey } from "./renewal-idempotency";
import { GatewayIcon } from "@/components/ui/gateway-icon";
import { SubscriptionSelectCard } from "@/components/subscription/subscription-select-card";
import { StepTransition } from "@/components/ui/step-transition";
import { BackButton } from "@/components/ui/back-button";
import { useAccessMode, useRenewalAddOnsEnabled } from "@/lib/use-access-mode";
import { AccessModeBlockedScreen } from "@/components/access-mode-banner";
import { selectRenewalReoffer } from "./renewal-reoffer";
import {
  formatSavedPaymentMethodMeta,
  formatSavedPaymentMethodTitle,
} from "@/lib/saved-payment-method-display";
import { CreditCard } from "lucide-react";
import {
  addCurrencyAmounts,
  formatCurrencyAmount,
  resolveRenewalAddOnReview,
} from "./renewal-review-policy";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";

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

/** Maps a backend renewal warning code to a localized "why not renewable" hint. */
const RENEWAL_REASON_KEYS: Record<string, string> = {
  TRIAL_FREE_NOT_RENEWABLE: "renewal.reason.trial",
  SOURCE_PLAN_MISSING: "renewal.reason.noPlan",
  GATEWAY_NOT_AVAILABLE: "renewal.reason.noGateway",
  ARCHIVED_PLAN_REPLACEMENT: "renewal.reason.archived",
};

function formatPrice(amount: string | null, currency: string | null): string {
  if (amount === null || currency === null) return "—";
  const symbol = CURRENCY_SYMBOLS[currency] ?? "";
  return `${symbol}${formatCurrencyAmount(amount)} ${currency}`;
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

  // A free trial can't be renewed — the user must UPGRADE. Decide this up
  // front, using the AUTHORITATIVE per-subscription `renewable` flag (so PAID
  // trials, which ARE renewable, still get the normal wizard) and bounce to
  // /upgrade BEFORE rendering any renewal chrome. Without this the user sees a
  // "Продление" screen flash before being redirected to "Улучшение". Both
  // queries share their keys with the wizard steps, so this adds no network.
  const { data: baseOptions, isLoading: optionsLoading } = useQuery({
    queryKey: ["renewal-options", {}, {}],
    queryFn: () => getRenewalOptions(),
    staleTime: 60_000,
  });
  const { data: subsData, isLoading: subsLoading } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const decided = !optionsLoading && !subsLoading;
  const nothingRenewable = (baseOptions?.items ?? []).every((o) => !o.renewable);
  const hasTrial = (subsData?.subscriptions ?? []).some((s) => s.isTrial);
  const redirectToUpgrade = decided && nothingRenewable && hasTrial;

  useEffect(() => {
    if (redirectToUpgrade) navigate("/upgrade", { replace: true });
  }, [redirectToUpgrade, navigate]);

  // Renewal stays OPEN under PURCHASE_BLOCKED (so users keep their VPN); only
  // the emergency RESTRICTED freeze blocks it.
  if (restricted) {
    return (
      <AccessModeBlockedScreen modes={["RESTRICTED"]} onBack={() => navigate("/dashboard")} />
    );
  }

  // Until the renew-vs-upgrade decision is settled on entry (or we're about to
  // bounce a trial to upgrade), show a neutral loader — never the "Продление"
  // chrome — so the trial → upgrade hand-off feels seamless.
  if (step === "subscriptions" && (!decided || redirectToUpgrade)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
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
        {step === "plan" && <SelectPlan />}
        {step === "addons" && <SelectRenewalAddOns />}
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
  const navigate = useNavigate();
  const {
    selectedSubscriptionIds,
    selectedDurations,
    selectedPlans,
    toggleSubscription,
    setSelectedSubscriptions,
    setSelectedDuration,
    setStep,
  } = useRenewalStore();

  const durationsPayload = Object.entries(selectedDurations).map(([subscriptionId, days]) => ({
    subscriptionId,
    days,
  }));
  const plansPayload = Object.entries(selectedPlans).map(([subscriptionId, planId]) => ({
    subscriptionId,
    planId,
  }));

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ["renewal-options", selectedDurations, selectedPlans],
    queryFn: () =>
      getRenewalOptions({
        ...(durationsPayload.length > 0 ? { durations: durationsPayload } : {}),
        ...(plansPayload.length > 0 ? { plans: plansPayload } : {}),
      }),
    staleTime: 60_000,
  });
  const { data: subsData, isLoading: subsLoading } = useQuery({
    queryKey: subscriptionQueryKeys.all,
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

  // Free-trial subscriptions can't be renewed — the user must UPGRADE to a
  // paid plan instead. Detect them so we can route to the upgrade flow.
  const trialSubs = (subsData?.subscriptions ?? []).filter((sub) => {
    const opt = optionById.get(sub.id);
    return sub.isTrial && (opt === undefined || !opt.renewable);
  });

  // Skip the selection step entirely when there is exactly one renewable
  // subscription — auto-select it and advance. A plan-less sub goes to the
  // tariff-selection step first; others go straight to the gateway.
  useEffect(() => {
    if (!isLoading && renewable.length === 1 && selectedSubscriptionIds.length === 0) {
      const only = renewable[0]!;
      setSelectedSubscriptions([only.sub.id]);
      setStep(only.option.requiresPlanSelection && !selectedPlans[only.sub.id] ? "plan" : "gateway");
    }
  }, [isLoading, renewable, selectedSubscriptionIds.length, selectedPlans, setSelectedSubscriptions, setStep]);

  // Trying to renew but nothing is renewable and the user holds a free trial →
  // send them to the upgrade flow (a trial is upgraded, never renewed).
  useEffect(() => {
    if (!isLoading && renewable.length === 0 && trialSubs.length > 0) {
      navigate("/upgrade", { replace: true });
    }
  }, [isLoading, renewable.length, trialSubs.length, navigate]);

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
    // Trials are being redirected to upgrade — render nothing to avoid a flash.
    if (trialSubs.length > 0) return null;
    // Surface the most relevant reason instead of a bare "none renewable".
    const reasonCode = (options?.items ?? [])
      .flatMap((i) => i.warnings.map((w) => w.code))
      .find((c) => RENEWAL_REASON_KEYS[c] !== undefined);
    const reason = reasonCode ? t(RENEWAL_REASON_KEYS[reasonCode]!) : null;
    return (
      <div className="px-5 space-y-2">
        <TipCard tone="info">{t("renewal.noneRenewable")}</TipCard>
        {reason && <p className="px-1 text-xs text-zinc-500">{reason}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-zinc-400">{t("renewal.selectSubtitle")}</p>
      <div className="px-5 space-y-2">
        {renewable.map(({ sub, option }, index) => {
          const checked = selectedSubscriptionIds.includes(sub.id);
          const needsPlan = (option.requiresPlanSelection ?? false) && !selectedPlans[sub.id];
          const planLabel = sub.plan?.name ?? option.planName ?? "";
          const currentDays = selectedDurations[sub.id] ?? option.durationDays;
          const durationLabel = currentDays
            ? t("purchase.duration.days", { count: currentDays })
            : "";
          const subtitle = needsPlan
            ? t("renewal.choosePlanHint")
            : [planLabel, durationLabel].filter(Boolean).join(" · ");
          const showDurationPicker = !needsPlan && option.availableDurations.length > 1;
          return (
            <div key={sub.id} className="space-y-2">
              <SubscriptionSelectCard
                subscription={sub}
                selected={checked}
                onSelect={() => toggleSubscription(sub.id)}
                control="check"
                index={index}
                subtitle={subtitle}
                trailing={
                  needsPlan ? (
                    <span className="text-xs font-medium text-(--brand-primary)">
                      {t("renewal.choosePlanCta")}
                    </span>
                  ) : (
                    <span className="text-sm font-semibold text-(--brand-primary)">
                      {formatPrice(option.amount, option.currency)}
                    </span>
                  )
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
          onClick={() => {
            // If any chosen subscription still needs a tariff, go pick it first.
            const needsPlan = selectedSubscriptionIds.some((id) => {
              const opt = optionById.get(id);
              return (opt?.requiresPlanSelection ?? false) && !selectedPlans[id];
            });
            setStep(needsPlan ? "plan" : "gateway");
          }}
        >
          {t("renewal.continue")}
        </StadiumButton>
      </div>
    </div>
  );
}

/**
 * Tariff-selection step for plan-less (panel-imported) subscriptions: pick a
 * plan from the catalog (+ a duration) for each selected subscription that has
 * no inherent plan, then continue to the gateway.
 */
function SelectPlan() {
  const { t } = useTranslation();
  const {
    selectedSubscriptionIds,
    selectedPlans,
    selectedDurations,
    setSelectedPlan,
    setSelectedDuration,
    setStep,
    goBack,
  } = useRenewalStore();

  const { data: plans = [], isLoading: plansLoading } = useQuery({
    queryKey: ["plans"],
    queryFn: getPlans,
    staleTime: 300_000,
  });
  const { data: baseOptions, isLoading: baseLoading } = useQuery({
    queryKey: ["renewal-options", {}, {}],
    queryFn: () => getRenewalOptions(),
    staleTime: 60_000,
  });
  const { data: subsData } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const isLoading = plansLoading || baseLoading;

  const optionById = new Map((baseOptions?.items ?? []).map((o) => [o.subscriptionId, o]));
  const subById = new Map((subsData?.subscriptions ?? []).map((s) => [s.id, s]));
  // Only paid plans are valid renewal targets.
  const catalog = plans.filter((p) => !(p.isTrial && p.trialFree));
  const targets = selectedSubscriptionIds.filter(
    (id) => optionById.get(id)?.requiresPlanSelection ?? false,
  );
  // "Chosen" only counts once we actually know the targets (post-load).
  const allChosen = targets.length > 0 && targets.every((id) => Boolean(selectedPlans[id]));

  // Reached the plan step but nothing needs a tariff (e.g. all selected subs
  // already carry a plan) → skip straight to the gateway. Never strand here.
  useEffect(() => {
    if (!isLoading && targets.length === 0) {
      setStep(selectedSubscriptionIds.length === 0 ? "subscriptions" : "gateway");
    }
  }, [isLoading, targets.length, selectedSubscriptionIds.length, setStep]);

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
    <div className="space-y-4">
      <p className="px-5 text-sm text-zinc-400">{t("renewal.choosePlanTitle")}</p>
      {targets.map((subId) => {
        const sub = subById.get(subId);
        const chosenPlanId = selectedPlans[subId];
        const chosenPlan = catalog.find((p) => String(p.id) === chosenPlanId);
        return (
          <div key={subId} className="space-y-2 px-5">
            {targets.length > 1 && sub && (
              <p className="text-xs font-medium text-zinc-500">{subscriptionTitle(sub)}</p>
            )}
            {catalog.map((plan, idx) => (
              <TariffCard
                key={plan.id}
                plan={plan}
                index={idx}
                selected={String(plan.id) === chosenPlanId}
                onClick={() => {
                  setSelectedPlan(subId, String(plan.id));
                  const firstDays = plan.durations[0]?.days;
                  if (firstDays) setSelectedDuration(subId, firstDays);
                }}
              />
            ))}
            {chosenPlan && chosenPlan.durations.length > 1 && (
              <div className="pt-1">
                <p className="mb-1.5 text-xs text-zinc-500">{t("renewal.durationLabel")}</p>
                <div className="flex flex-wrap gap-2">
                  {chosenPlan.durations.map((d) => {
                    const active = (selectedDurations[subId] ?? chosenPlan.durations[0]?.days) === d.days;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setSelectedDuration(subId, d.days)}
                        className={cn(
                          "rounded-full px-3 py-1.5 text-xs font-medium transition-all active:scale-95",
                          active
                            ? "bg-(--brand-primary) text-black"
                            : "bg-white/5 text-zinc-300 hover:bg-white/10",
                        )}
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

      <div className="px-5 space-y-2 pt-2">
        <StadiumButton
          fullWidth
          size="lg"
          glow
          disabled={!allChosen}
          onClick={() => setStep("gateway")}
        >
          {t("renewal.continue")}
        </StadiumButton>
        <StadiumButton fullWidth variant="ghost" onClick={() => goBack("subscriptions")}>
          {t("renewal.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function SelectRenewalAddOns() {
  const { t } = useTranslation();
  const {
    selectedSubscriptionIds,
    selectedGateway,
    selectedAddOns,
    toggleAddOn,
    reconcileReoffer,
    setStep,
    goBack,
    navDirection,
  } = useRenewalStore();
  const currency = selectedGateway?.currency ?? null;
  const multi = selectedSubscriptionIds.length > 1;

  const { data: subsData } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const subById = new Map((subsData?.subscriptions ?? []).map((s) => [s.id, s]));

  // Re-offer source: the add-ons the user had ACTIVE in the current cycle.
  const {
    data: historyData,
    isLoading: historyLoading,
    isFetching: historyFetching,
    isError: historyError,
  } = useQuery({
    queryKey: ["add-on-entitlements"],
    queryFn: getAddOnEntitlements,
    staleTime: 60_000,
  });

  // Current eligibility per selected subscription (server authority + price).
  const eligQueries = useQueries({
    queries: selectedSubscriptionIds.map((subId) => ({
      queryKey: ["add-ons-eligibility", subId],
      queryFn: () => getSubscriptionAddOns(subId),
      staleTime: 60_000,
    })),
  });

  const loading =
    historyLoading ||
    historyFetching ||
    eligQueries.some((query) => query.isLoading || query.isFetching);

  // Per-subscription re-offer = eligible+priced add-ons the user had active in
  // the current cycle, matched to the catalog by id (or type+value for legacy
  // rows without an addOnId). Only these are re-offered — the renewal never
  // shows a generic add-on catalog here.
  const reofferBySub = new Map<string, readonly EligibleAddOn[]>();
  selectedSubscriptionIds.forEach((subId, index) => {
    const eligibility = eligQueries[index];
    const reoffer = selectRenewalReoffer({
      subscriptionId: subId,
      currency,
      history: historyError ? null : (historyData?.entitlements ?? null),
      eligibleAddOns:
        !eligibility?.isError && eligibility?.data?.availability === "AVAILABLE"
          ? eligibility.data.addOns
          : null,
    });
    if (reoffer.length > 0) reofferBySub.set(subId, reoffer);
  });
  const totalReofferable = [...reofferBySub.values()].reduce(
    (count, list) => count + list.length,
    0,
  );
  const reofferKey = `${selectedSubscriptionIds.join("\u0000")}|${currency ?? ""}`;
  const allowedBySubscription = Object.fromEntries(
    [...reofferBySub].map(([subId, list]) => [subId, list.map((addOn) => addOn.id)]),
  );
  const reofferFingerprint = selectedSubscriptionIds
    .map((subId) => `${subId}:${(allowedBySubscription[subId] ?? []).slice().sort().join(",")}`)
    .join("|");

  // A new composition gets defaults once. Settled refetches for the same
  // composition only intersect the current selection with the live allowed set,
  // so removed/expired/error entries cannot leak into checkout and explicit
  // user deselections are never restored.
  useEffect(() => {
    if (loading) return;
    reconcileReoffer(reofferKey, allowedBySubscription);
    if (totalReofferable === 0) {
      if (navDirection === "back") goBack("gateway");
      else setStep("review");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, totalReofferable, reofferKey, reofferFingerprint]);

  if (loading) {
    return (
      <div className="px-5" role="status" aria-live="polite">
        <div className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="px-5">
        <h2 className="text-base font-semibold">{t("renewal.reofferTitle")}</h2>
        <p className="mt-1 text-sm text-zinc-400">{t("renewal.reofferSubtitle")}</p>
      </div>
      {selectedSubscriptionIds.map((subId) => {
        const list = reofferBySub.get(subId);
        if (!list || list.length === 0) return null;
        const sub = subById.get(subId);
        return (
          <RenewalAddOnSection
            key={subId}
            title={multi ? (sub ? subscriptionTitle(sub) : subId) : null}
            currency={currency}
            addOns={list}
            selectedIds={selectedAddOns[subId] ?? []}
            onToggle={(addOnId) => toggleAddOn(subId, addOnId)}
          />
        );
      })}
      <div className="px-5 space-y-2 pt-2">
        <StadiumButton fullWidth size="lg" glow onClick={() => setStep("review")}>
          {t("renewal.continue")}
        </StadiumButton>
        <StadiumButton fullWidth variant="ghost" onClick={() => goBack("gateway")}>
          {t("renewal.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function RenewalAddOnSection({
  title,
  currency,
  addOns,
  selectedIds,
  onToggle,
}: {
  title: string | null;
  currency: string | null;
  addOns: readonly EligibleAddOn[];
  selectedIds: readonly string[];
  onToggle: (addOnId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 px-5">
      {title && <p className="text-xs font-medium text-zinc-500">{title}</p>}
      {addOns.map((addOn) => {
        const selected = selectedIds.includes(addOn.id);
        const price = currency ? addOn.prices.find((p) => p.currency === currency) : undefined;
        return (
          <button
            key={addOn.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onToggle(addOn.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition-all active:scale-[0.98]",
              selected
                ? "border-(--brand-primary)/60 bg-(--brand-primary)/10"
                : "border-white/6 bg-white/3 hover:bg-white/6",
            )}
          >
            <div
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
                selected ? "border-(--brand-primary) bg-(--brand-primary) text-black" : "border-white/20",
              )}
            >
              {selected && <Check className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white">{addOn.name}</p>
              <p className="text-xs text-zinc-500">
                {addOn.type === "EXTRA_TRAFFIC"
                  ? t("addons.extraTraffic", { value: addOn.value })
                  : t("addons.extraDevices", { count: addOn.value })}
              </p>
              {addOn.description && (
                <p className="mt-0.5 text-xs text-zinc-500/80 line-clamp-2">{addOn.description}</p>
              )}
            </div>
            {price && (
              <span className="shrink-0 text-sm font-semibold text-(--brand-primary)">
                {formatPrice(price.price, price.currency)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SelectGateway() {
  const { t } = useTranslation();
  const {
    selectGateway,
    selectSavedPaymentMethod,
    selectedGateway,
    selectedSavedPaymentMethodId,
    setStep,
    goBack,
    navDirection,
  } = useRenewalStore();
  const renewalAddOns = useRenewalAddOnsEnabled();
  // Policy-settled signal (same shared query): the add-on capability must be
  // resolved before we auto-advance a single gateway, otherwise a one-gateway
  // user with renewalAddOns enabled could be auto-advanced gateway→review while
  // the flag still reads false, silently skipping the add-on step.
  const { isLoading: policyLoading } = useAccessMode();
  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });
  const yookassaEnabled = gateways.some((gw) => gw.type === "YOOKASSA");
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

  const choose = (
    gw: { type: string; displayName: string; currency: string },
    savedPaymentMethodId: string | null = null,
  ): void => {
    selectGateway({
      id: gw.type,
      label: gatewayLabel(gw.type, gw.displayName),
      icon: GATEWAY_ICONS[gw.type] ?? "💳",
      currency: gw.currency,
    } satisfies GatewayOption);
    // selectGateway clears saved method; re-apply after the store update.
    queueMicrotask(() => selectSavedPaymentMethod(savedPaymentMethodId));
    // Optional add-on selection step sits between gateway and review — only
    // when the backend rollout enables it (otherwise pricing ignores add-ons).
    setStep(renewalAddOns ? "addons" : "review");
  };

  // Auto-select when a single gateway is available — but only when arriving
  // FORWARD. Without the guard, pressing "back" from review re-mounts this and
  // immediately re-advances to review (a trap). Skip auto-advance when the
  // user has saved YooKassa methods so they can pick a card.
  useEffect(() => {
    if (
      !isLoading &&
      !policyLoading &&
      gateways.length === 1 &&
      navDirection === "forward" &&
      savedYookassaMethods.length === 0
    ) {
      choose(gateways[0]!);
    }
  }, [isLoading, policyLoading, gateways, navDirection, savedYookassaMethods.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
                  choose(yookassa, method.id);
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
              choose(yookassa, null);
            }}
            className={cn(
              "w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all",
              selectedGateway?.id === "YOOKASSA" &&
                selectedSavedPaymentMethodId === null &&
                "border-(--brand-primary)/40 bg-(--brand-primary)/5",
            )}
          >
            <GatewayIcon type="YOOKASSA" currency="RUB" className="h-7 w-7" />
            <div className="text-left">
              <p className="font-medium text-white">{t("purchase.gateway.newCard")}</p>
              <p className="text-xs text-zinc-500">YooKassa</p>
            </div>
          </button>
        </div>
      )}
      <div className="px-5 space-y-2">
        {sorted
          .filter((gw) => !(savedYookassaMethods.length > 0 && gw.type === "YOOKASSA"))
          .map((gw) => (
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
        <StadiumButton fullWidth variant="ghost" onClick={() => goBack("subscriptions")}>
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
  const {
    selectedSubscriptionIds,
    selectedDurations,
    selectedPlans,
    selectedAddOns,
    selectedGateway,
    selectedSavedPaymentMethodId,
    savePaymentMethodConsent,
    setSavePaymentMethodConsent,
    setReviewQuote,
    setStep,
    goBack,
  } = useRenewalStore();
  const showSaveCardConsent =
    selectedGateway?.id === "YOOKASSA" && !selectedSavedPaymentMethodId;

  const durationsPayload = selectedSubscriptionIds
    .filter((id) => selectedDurations[id] !== undefined)
    .map((id) => ({ subscriptionId: id, days: selectedDurations[id]! }));
  const plansPayload = selectedSubscriptionIds
    .filter((id) => selectedPlans[id] !== undefined)
    .map((id) => ({ subscriptionId: id, planId: selectedPlans[id]! }));

  const {
    data,
    isLoading,
    isFetching,
    error,
  } = useQuery({
    queryKey: ["renewal-review", selectedSubscriptionIds, selectedGateway?.id, selectedDurations, selectedPlans],
    queryFn: () =>
      getRenewalOptions({
        subscriptionIds: selectedSubscriptionIds,
        gatewayType: selectedGateway!.id,
        ...(durationsPayload.length > 0 ? { durations: durationsPayload } : {}),
        ...(plansPayload.length > 0 ? { plans: plansPayload } : {}),
      }),
    enabled: selectedSubscriptionIds.length > 0 && !!selectedGateway,
  });
  const { data: subsData } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const subById = new Map((subsData?.subscriptions ?? []).map((s) => [s.id, s]));

  // Selected renewal add-ons (T-015): resolve names/prices from the same
  // per-subscription eligibility used by the selection step (cached), so the
  // review lists them and the displayed total matches what the backend prices.
  const currency = selectedGateway?.currency ?? null;
  const hasAddOnSelections = Object.values(selectedAddOns).some((ids) => ids.length > 0);
  const eligibilityQueries = useQueries({
    queries: selectedSubscriptionIds.map((id) => ({
      queryKey: ["add-ons-eligibility", id],
      queryFn: () => getSubscriptionAddOns(id),
      staleTime: 60_000,
      enabled: hasAddOnSelections,
    })),
  });
  const addOnReview = resolveRenewalAddOnReview({
    selectedSubscriptionIds,
    selectedAddOns,
    currency,
    eligibilityQueries,
  });
  const addOnLines = addOnReview.status === "READY" ? addOnReview.lines : [];
  const addOnTotal = addOnReview.status === "READY" ? addOnReview.addOnTotal : "0";

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
      void queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["partner", "info"] });
      navigate("/dashboard", { replace: true });
    },
    onError: () => toast.error(t("renewal.balanceError")),
  });

  if (isLoading || isFetching || addOnReview.status === "PENDING") {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    );
  }

  const items: RenewalOptionItem[] = (data?.items ?? []).filter((i) =>
    selectedSubscriptionIds.includes(i.subscriptionId),
  );
  const confirmedAmount =
    typeof data?.total === "string" ? addCurrencyAmounts([data.total, addOnTotal]) : null;
  const priceError =
    error ||
    !data ||
    data.total === null ||
    data.currency === null ||
    data.currency !== currency ||
    confirmedAmount === null ||
    items.some((item) => !item.renewable) ||
    addOnReview.status === "ERROR";
  // Partner-balance pay is offered only for a single-subscription renewal whose
  // priced currency matches the partner balance currency and is covered by it.
  const balanceItem =
    items.length === 1 && items[0]!.planId !== null && items[0]!.durationDays !== null
      ? items[0]!
      : null;
  const balanceEligible =
    addOnReview.allowsPartnerBalance &&
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
        <TipCard tone="danger" role="alert">{t("renewal.priceError")}</TipCard>
        <StadiumButton fullWidth variant="secondary" onClick={() => goBack("gateway")}>
          {t("renewal.back")}
        </StadiumButton>
      </div>
    );
  }

  const confirmedCurrency = data!.currency!;

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
        {addOnLines.map(({ subscriptionId, addOn, price }) => (
          <div
            key={`${subscriptionId}:${addOn.id}`}
            className="flex items-center justify-between px-4 py-3 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate text-white">{addOn.name}</p>
              <p className="truncate text-xs text-zinc-500">
                {addOn.type === "EXTRA_TRAFFIC"
                  ? t("addons.extraTraffic", { value: addOn.value })
                  : t("addons.extraDevices", { count: addOn.value })}
              </p>
            </div>
            <span className="shrink-0 font-medium">
              {price !== null ? formatPrice(price, currency) : "—"}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="font-semibold">{t("renewal.total")}</span>
          <span className="text-lg font-bold text-(--brand-primary)">
            {formatPrice(confirmedAmount, confirmedCurrency)}
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

      {showSaveCardConsent && (
        <div className="flex items-start justify-between gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
          <div className="min-w-0 text-zinc-300 leading-snug">
            <p className="font-medium text-zinc-100">{t("purchase.quote.saveCardTitle")}</p>
            <p id="renewal-save-card-hint" className="mt-0.5 text-xs text-zinc-400">
              {t("purchase.quote.saveCardHint")}
            </p>
          </div>
          <Switch
            className="mt-0.5"
            checked={savePaymentMethodConsent}
            onCheckedChange={setSavePaymentMethodConsent}
            aria-label={t("purchase.quote.saveCardTitle")}
            aria-describedby="renewal-save-card-hint"
          />
        </div>
      )}

      <StadiumButton
        fullWidth
        size="lg"
        glow
        icon={<Check className="h-5 w-5" />}
        onClick={() => {
          setReviewQuote({ amount: confirmedAmount, currency: confirmedCurrency });
          setStep("checkout");
        }}
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
  const {
    selectedSubscriptionIds,
    selectedDurations,
    selectedPlans,
    selectedAddOns,
    selectedGateway,
    selectedSavedPaymentMethodId,
    savePaymentMethodConsent,
    reviewQuote,
    setCheckoutResult,
    goBack,
  } = useRenewalStore();

  const durationsPayload = selectedSubscriptionIds
    .filter((id) => selectedDurations[id] !== undefined)
    .map((id) => ({ subscriptionId: id, days: selectedDurations[id]! }));
  const plansPayload = selectedSubscriptionIds
    .filter((id) => selectedPlans[id] !== undefined)
    .map((id) => ({ subscriptionId: id, planId: selectedPlans[id]! }));
  const addOnsPayload = selectedSubscriptionIds
    .filter((id) => (selectedAddOns[id]?.length ?? 0) > 0)
    .map((id) => ({ subscriptionId: id, addOnIds: selectedAddOns[id]! }));
  const [attemptId] = useState(() => crypto.randomUUID());
  // Stable per checkout attempt (per mount): a double-invoke / network-ambiguous
  // retry replays the existing draft instead of minting a second PENDING
  // combined-renewal transaction. A fresh attempt (remount) gets a new key.
  const idempotencyKey = useMemo(
    () =>
      createRenewalIdempotencyKey(
        {
          subscriptionIds: selectedSubscriptionIds,
          gatewayType: selectedGateway?.id ?? "",
          quote: reviewQuote ?? { amount: "", currency: "" },
          durations: durationsPayload,
          plans: plansPayload,
          addOns: addOnsPayload,
          savedPaymentMethodId: selectedSavedPaymentMethodId,
        },
        attemptId,
      ),
    [
      selectedSubscriptionIds,
      selectedGateway?.id,
      reviewQuote,
      durationsPayload,
      plansPayload,
      addOnsPayload,
      selectedSavedPaymentMethodId,
      attemptId,
    ],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!selectedGateway || !reviewQuote) {
        throw new Error("RENEWAL_QUOTE_MISSING");
      }
      const interactiveYookassa =
        selectedGateway.id === "YOOKASSA" && !selectedSavedPaymentMethodId;
      return createRenewalCheckout(
        selectedSubscriptionIds,
        selectedGateway.id,
        reviewQuote,
        durationsPayload.length > 0 ? durationsPayload : undefined,
        plansPayload.length > 0 ? plansPayload : undefined,
        addOnsPayload.length > 0 ? addOnsPayload : undefined,
        idempotencyKey,
        selectedSavedPaymentMethodId,
        interactiveYookassa ? savePaymentMethodConsent : undefined,
        interactiveYookassa ? savePaymentMethodConsent : undefined,
      );
    },
    onSuccess: (result) => {
      setCheckoutResult(result.paymentId, result.checkoutUrl ?? null);
      // Stash the URL so the return page can offer a manual "open payment"
      // button — the auto-open below is blocked on Telegram Desktop (openLink
      // must run inside a user gesture, which the async onSuccess has lost).
      savePendingCheckout(result.paymentId, result.checkoutUrl ?? null, { returnTo: "/renew" });
      if (result.checkoutUrl) openExternalUrl(result.checkoutUrl);
      navigate(`/payment-return?paymentId=${result.paymentId}`, { replace: true });
    },
    onError: () => {
      // Return to review (not a stuck spinner) so the user can retry.
      toast.error(t("renewal.checkoutError"));
      goBack("review");
    },
  });

  useEffect(() => {
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4" role="status" aria-live="polite">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-zinc-400">{t("renewal.creating")}</p>
    </div>
  );
}
