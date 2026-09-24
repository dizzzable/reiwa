import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ArrowUpCircle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  createUpgradeCheckout,
  getAllSubscriptions,
  getEnabledGateways,
  getPlans,
  getQuote,
  getUpgradeOptions,
} from "@/lib/api-client";
import type { UpgradePlanOption } from "@/lib/api-client/subscription";
import { TariffCard } from "@/features/plans/tariff-card";
import { upgradeCardPlan } from "./upgrade-card-plan";
import { describeCarriedAbovePlan } from "./carried-above-plan";
import { describeActiveAddOns } from "./active-add-ons";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { useUpgradeStore } from "@/stores/upgrade.store";
import type { GatewayOption } from "@/stores/purchase.store";
import { gatewayLabel } from "@/lib/gateway-display";
import { GatewayIcon } from "@/components/ui/gateway-icon";
import { SubscriptionSelectCard } from "@/components/subscription/subscription-select-card";
import { StepTransition } from "@/components/ui/step-transition";
import { BackButton } from "@/components/ui/back-button";
import { useAccessMode } from "@/lib/use-access-mode";
import { AccessModeBlockedScreen } from "@/components/access-mode-banner";
import { startCheckoutRedirect } from "@/lib/utils";
import { savePendingCheckout } from "@/lib/pending-checkout";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import {
  isPlanUnavailableRefusal,
  isQuoteNotEligibleRefusal,
  notifyPlanUnavailable,
  readUnpricedQuote,
} from "@/features/purchase/plan-unavailable";
import {
  isLifetimeRenewalRefusal,
  isUpgradeClosedForLifetime,
  SUBSCRIPTION_IS_LIFETIME_CODE,
  warnsLifetime,
} from "@/features/renewal/lifetime-renewal";

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

export default function UpgradePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { step, reset, selectedSubscriptionId, selectedPlan, selectedDurationDays, selectedGateway } =
    useUpgradeStore();
  const { purchasesBlocked } = useAccessMode();
  // The review (subscription, target, term, gateway) the panel refused at
  // checkout without a reason. Held here because the checkout step that learns
  // it unmounts on the way back to the review that has to show it.
  const [refusedReviewKey, setRefusedReviewKey] = useState<string | null>(null);
  const reviewKey = [selectedSubscriptionId, selectedPlan?.id, selectedDurationDays, selectedGateway?.id]
    .map(String)
    .join("|");

  useEffect(() => () => reset(), [reset]);

  // Upgrade is a new purchase — blocked under PURCHASE_BLOCKED / RESTRICTED.
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
        <BackButton fallback="/dashboard" label={t("upgrade.back")} />
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t("upgrade.title")}</h1>
        </div>
      </div>

      {/* `checkout` and `polling` render the same child, so they must share a
          transition key. A changing key remounts it — a fresh `CheckoutStep`
          with a fresh ref latch, which would create a second draft. Today
          that is masked only because `setCheckoutResult` (which sets
          `polling`) and `navigate("/payment-return")` batch into one commit
          and the unmount wins the race; keying them together removes the
          dependency on that ordering. */}
      <StepTransition stepKey={step === "polling" ? "checkout" : step}>
        {step === "subscriptions" && <SelectSubscription />}
        {step === "plan" && <SelectPlan />}
        {step === "duration" && <SelectDuration />}
        {step === "gateway" && <SelectGateway />}
        {step === "review" && <UpgradeReview refused={refusedReviewKey === reviewKey} />}
        {(step === "checkout" || step === "polling") && (
          <CheckoutStep onQuoteRefused={() => setRefusedReviewKey(reviewKey)} />
        )}
      </StepTransition>
    </div>
  );
}

function SelectSubscription() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectSubscription } = useUpgradeStore();

  const { data, isLoading } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });

  // EXPIRED is upgrade-eligible on the backend (only DELETED is excluded) —
  // an expired subscription is exactly the case a user wants to upgrade out
  // of. DISABLED stays excluded: that's an admin-toggled freeze, not
  // something the user should route around via upgrade.
  const candidates = (data?.subscriptions ?? []).filter(
    (s) => s.status === "ACTIVE" || s.status === "LIMITED" || s.status === "EXPIRED",
  );
  // A subscription with no end date is not upgraded by a purchase
  // (`features/renewal/lifetime-renewal.ts`): left out, and the page says why.
  // One the list shows with the VPN panel's date is caught by its options.
  const active = candidates.filter((s) => !isUpgradeClosedForLifetime(s));
  const lifetimeLeftOut = candidates.length > active.length;

  useEffect(() => {
    if (!isLoading && active.length === 1 && selectedSubscriptionId === null) {
      selectSubscription(active[0]!.id);
    }
  }, [isLoading, active, selectedSubscriptionId, selectSubscription]);

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="theme-skeleton h-20 animate-pulse rounded-2xl" />
        ))}
      </div>
    );
  }

  if (active.length === 0) {
    return (
      <div className="px-5">
        <TipCard tone="info">{t(lifetimeLeftOut ? "upgrade.lifetime" : "upgrade.noneUpgradeable")}</TipCard>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-[color:var(--brand-muted-foreground)]">{t("upgrade.selectSubtitle")}</p>
      <div className="px-5 space-y-2">
        {active.map((sub, index) => (
          <SubscriptionSelectCard
            key={sub.id}
            subscription={sub}
            selected={sub.id === selectedSubscriptionId}
            onSelect={() => selectSubscription(sub.id)}
            control="radio"
            index={index}
            subtitle={sub.plan?.name ?? undefined}
          />
        ))}
      </div>
      {lifetimeLeftOut && (
        <div className="px-5">
          <TipCard tone="info">{t("upgrade.lifetime")}</TipCard>
        </div>
      )}
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
  // The cards «Тарифы» and renewal draw, from the same catalog query they hold
  // (same key, same freshness). An upgrade option carries only what this flow
  // needs — no icon, description, prices or card look — so each is drawn as
  // its catalog plan; see `upgradeCardPlan`.
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ["plans"],
    queryFn: getPlans,
    staleTime: 300_000,
  });

  if (isLoading || catalogLoading) {
    return (
      <div className="px-5 space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="theme-skeleton h-[150px] animate-pulse rounded-card" />
        ))}
      </div>
    );
  }

  const plans = data?.plans ?? [];
  if (plans.length === 0) {
    return (
      <div className="px-5 space-y-3">
        {/* The panel closes an upgrade of a subscription with no end date and
            says so in its warnings — the one word for a subscription the list
            showed with the VPN panel's date. */}
        <TipCard tone="info">{t(warnsLifetime(data?.warnings) ? "upgrade.lifetime" : "upgrade.noTargets")}</TipCard>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("upgrade.back")}
        </StadiumButton>
      </div>
    );
  }

  const catalogById = new Map((catalog ?? []).map((plan) => [String(plan.id), plan]));

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("upgrade.choosePlan")}</h2>
      <div className="px-5 space-y-3">
        {plans.map((option, idx) => {
          const cardPlan = upgradeCardPlan(option, catalogById.get(String(option.id)));
          return cardPlan ? (
            <TariffCard key={option.id} plan={cardPlan} index={idx} onClick={() => selectPlan(option)} />
          ) : (
            <button
              key={option.id}
              onClick={() => selectPlan(option)}
              className="w-full glass-card flex items-center justify-between gap-3 p-4 text-left transition-all hover:border-(--brand-primary)/30 active:scale-[0.98]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[color:var(--brand-foreground)]">{option.name}</p>
                <p className="text-xs text-[color:var(--brand-muted-foreground)]">
                  {option.deviceLimit} {t("upgrade.devices")} ·{" "}
                  {option.trafficLimit === null
                    ? t("upgrade.unlimited")
                    : `${option.trafficLimit} ${t("upgrade.gb")}`}
                </p>
              </div>
              <Check className="h-4 w-4 shrink-0 text-[color:var(--brand-muted-foreground)]" />
            </button>
          );
        })}
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
  const { selectedPlan, selectedDurationDays, selectDuration, setStep } = useUpgradeStore();
  const durations = selectedPlan?.durations ?? [];

  // Only while no term is chosen. Back from the gateway step keeps the choice,
  // and re-advancing then made that Back a no-op. Picking a plan clears the
  // term, so arriving forward still skips a single-term step.
  useEffect(() => {
    if (durations.length === 1 && selectedDurationDays === null) {
      selectDuration(durations[0]!.days);
    }
  }, [durations, selectDuration, selectedDurationDays]);

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
            <span className="text-sm font-medium text-[color:var(--brand-foreground)]">
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
  const { selectedGateway, selectGateway, setStep } = useUpgradeStore();
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

  // Only while no gateway is chosen. Back from the review keeps the choice, and
  // re-advancing bounced the subscriber straight into the review they were
  // leaving — with a price error there, Back could never get out. Purchase and
  // renewal guard this effect on the navigation direction; this store records
  // none, and a gateway still chosen is what marks the way back in.
  useEffect(() => {
    if (!isLoading && gateways.length === 1 && selectedGateway === null) choose(gateways[0]!);
  }, [isLoading, gateways, selectedGateway]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="theme-skeleton h-16 animate-pulse rounded-2xl" />
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
              <p className="font-medium text-[color:var(--brand-foreground)]">{gatewayLabel(gw.type, gw.displayName)}</p>
              <p className="text-xs text-[color:var(--brand-muted-foreground)]">{gw.currency}</p>
            </div>
          </button>
        ))}
        {gateways.length === 0 && (
          <div className="py-8 text-center text-sm text-[color:var(--brand-muted-foreground)]">{t("purchase.gateway.empty")}</div>
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

/**
 * Leaves an upgrade whose target is no longer offered: says so and returns to
 * the target list, reset rather than invalidated so the withdrawn plan is not
 * rendered while it refetches. Re-selecting the subscription is the store's own
 * way onto that step with the stale term and gateway cleared.
 */
function useLeaveWithdrawnTarget(): () => void {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedSubscriptionId, selectSubscription, reset } = useUpgradeStore();
  return () => {
    notifyPlanUnavailable(t);
    void queryClient.resetQueries({ queryKey: ["upgrade-options"] });
    const subscriptionId = selectedSubscriptionId;
    reset();
    if (subscriptionId !== null) selectSubscription(subscriptionId);
  };
}

function UpgradeReview({ refused }: { readonly refused: boolean }) {
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

  // A target withdrawn before the review was priced is answered like the
  // checkout refusal below. Upgrade targets are never trials, and the quote
  // leads with its informational UPGRADE_RESETS_EXPIRY, so the whole warning
  // list is read. Told "try a different payment method" instead, Back led
  // through the gateway and term steps to a list still offering the target.
  const unpriced =
    !isLoading &&
    !error &&
    quote !== undefined &&
    (quote.warning !== undefined || typeof quote.finalPrice !== "number");
  // A subscription with no end date is not upgraded by a purchase: the panel
  // says so first, ahead of the PLAN_NOT_AVAILABLE a closed upgrade also
  // carries — which must not read as a withdrawn plan.
  const lifetime =
    unpriced &&
    (quote?.warning === SUBSCRIPTION_IS_LIFETIME_CODE ||
      warnsLifetime((quote as { readonly warnings?: unknown } | undefined)?.warnings));
  const withdrawn = unpriced && !lifetime && readUnpricedQuote(quote, false)?.kind === "withdrawn";
  const leaveWithdrawnTarget = useLeaveWithdrawnTarget();
  // StrictMode runs a mount effect twice, and a cached answer arrives on mount.
  const leftWithdrawnTarget = useRef(false);
  useEffect(() => {
    if (!withdrawn || leftWithdrawnTarget.current) return;
    leftWithdrawnTarget.current = true;
    leaveWithdrawnTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawn]);

  if (isLoading || withdrawn) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    );
  }

  if (lifetime) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="info">{t("upgrade.lifetime")}</TipCard>
        <StadiumButton fullWidth variant="secondary" onClick={() => setStep("subscriptions")}>
          {t("upgrade.back")}
        </StadiumButton>
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
  const carriedLine = describeCarriedAbovePlan(quote.carriedAbovePlan, selectedPlan, t);
  // The live add-ons, each until its own date (never past the new end). Kept
  // apart from «Сверх тарифа», which the panel sends without them.
  const addOnsLine = describeActiveAddOns(quote.activeAddOns, selectedPlan, t);
  // Days the old plan's paid remainder adds to the new term, as the panel
  // estimated them; it counts again at payment. With none — 0, or a panel older
  // than the field — the review says exactly what it always said.
  const paidRemainderDays =
    typeof quote.paidRemainderDays === "number" && quote.paidRemainderDays > 0 ? quote.paidRemainderDays : 0;
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
      <TipCard tone="info">
        {paidRemainderDays > 0 ? t("upgrade.resetsExpiryWithRemainder") : t("upgrade.resetsExpiry")}
      </TipCard>
      {paidRemainderDays > 0 && (
        <TipCard tone="info">{t("upgrade.paidRemainder", { days: paidRemainderDays })}</TipCard>
      )}
      {carriedLine !== null && <TipCard tone="info">{carriedLine}</TipCard>}
      {addOnsLine !== null && <TipCard tone="info">{addOnsLine}</TipCard>}
      {/* Refused at checkout without a reason, yet priced again: not a
          withdrawn target, and not something another press of Pay changes. */}
      {refused && <TipCard tone="danger">{t("purchase.checkout.notAccepted")}</TipCard>}
      {!refused && (
        <StadiumButton
          fullWidth
          size="lg"
          glow
          icon={<Check className="h-5 w-5" />}
          onClick={() => setStep("checkout")}
        >
          {t("upgrade.pay")}
        </StadiumButton>
      )}
      <StadiumButton fullWidth variant="ghost" onClick={() => setStep("gateway")}>
        {t("upgrade.change")}
      </StadiumButton>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-[color:var(--brand-muted-foreground)]">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function CheckoutStep({ onQuoteRefused }: { readonly onQuoteRefused: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    selectedSubscriptionId,
    selectedPlan,
    selectedDurationDays,
    selectedGateway,
    setCheckoutResult,
    setStep,
    reset,
  } = useUpgradeStore();
  const queryClient = useQueryClient();
  const leaveWithdrawnTarget = useLeaveWithdrawnTarget();

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
      // Stash the URL first: `startCheckoutRedirect` cannot navigate inside a
      // Telegram Mini App (no gesture on this path), so the buyer finishes from
      // the button on the return page — and that button needs this URL.
      savePendingCheckout(result.paymentId, result.checkoutUrl ?? null, { returnTo: "/upgrade" });
      if (result.checkoutUrl) startCheckoutRedirect(result.checkoutUrl);
      navigate(`/payment-return?paymentId=${result.paymentId}`, { replace: true });
    },
    onError: (err) => {
      if (isLifetimeRenewalRefusal(err)) {
        // The subscription has no end date (since the list loaded, or the list
        // showed the VPN panel's date), so no purchase changes its plan;
        // nothing was charged. Say so and start over from a fresh list.
        toast.error(t("upgrade.lifetime"));
        void queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
        void queryClient.resetQueries({ queryKey: ["upgrade-options"] });
        reset();
        return;
      }
      if (isPlanUnavailableRefusal(err)) {
        // The target plan was withdrawn after it was picked; nothing was
        // charged. The review can only fail the same way again, so go back to
        // the target list instead.
        leaveWithdrawnTarget();
        return;
      }
      if (isQuoteNotEligibleRefusal(err)) {
        // Refused without a reason; nothing was charged. From a panel that
        // predates PAYMENT_DRAFT_PLAN_NOT_AVAILABLE this may still be a
        // withdrawn target, so the review is re-priced (reset, so it cannot
        // decide on the refused copy) and its fresh answer tells which. If it
        // prices the same review again, this review is marked so Pay is not
        // offered a second time.
        onQuoteRefused();
        void queryClient.resetQueries({ queryKey: ["upgrade-quote"] });
        setStep("review");
        return;
      }
      // Return to review (not a stuck spinner) so the user can retry.
      toast.error(t("upgrade.checkoutError"));
      setStep("review");
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
      <p className="text-sm text-[color:var(--brand-muted-foreground)]">{t("upgrade.creating")}</p>
    </div>
  );
}
