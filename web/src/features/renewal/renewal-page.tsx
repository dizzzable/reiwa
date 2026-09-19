import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
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
import { PartnerBalanceHoldNotice } from "@/features/partner/partner-balance-hold-notice";
import { markPushPromptEligible } from "@/features/push-prompt/push-prompt-storage";
import { balanceHoldRefusalMessage, standingBalanceHold } from "@/lib/partner-balance-hold";
import { readSessionCheckRefusal } from "@/lib/session-check";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { PromoInput } from "@/features/purchase/components/promo-input";
import { useRenewalStore } from "@/stores/renewal.store";
import type { GatewayOption } from "@/stores/purchase.store";
import type { RenewalOptionItem, Subscription } from "@/types/api";
import { cn, startCheckoutRedirect } from "@/lib/utils";
import { savePendingCheckout } from "@/lib/pending-checkout";
import { TariffCard } from "@/features/plans/tariff-card";
import { gatewayLabel } from "@/lib/gateway-display";
import { createRenewalIdempotencyKey } from "./renewal-idempotency";
import { AutopayGatewayMark, GatewayIcon } from "@/components/ui/gateway-icon";
import { SubscriptionSelectCard } from "@/components/subscription/subscription-select-card";
import { StepTransition } from "@/components/ui/step-transition";
import { BackButton } from "@/components/ui/back-button";
import { useSafeBack } from "@/hooks/use-safe-back";
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
import { subscriptionTitle } from "@/lib/subscription-title";
import { notifyPlanUnavailable } from "@/features/purchase/plan-unavailable";

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
  TRIAL_NOT_RENEWABLE: "renewal.reason.trial",
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

/**
 * Subscriptions whose chosen plan the panel no longer renews onto.
 *
 * Only a plan-less (panel-imported) subscription carries a plan choice, and the
 * catalogue it was picked from can be stale — React Query keeps it for five
 * minutes. When the choice is not among the renewal targets, the
 * panel answers with no plan id and not renewable (`quoteSubscriptionRenewal`),
 * and keeps answering so for as long as the choice is sent.
 */
function withdrawnPlanChoices(
  items: readonly RenewalOptionItem[] | undefined,
  selectedPlans: Record<string, string>,
): string[] {
  return (items ?? [])
    .filter(
      (item) =>
        selectedPlans[item.subscriptionId] !== undefined && item.planId === null && !item.renewable,
    )
    .map((item) => item.subscriptionId);
}

/**
 * Lets go of withdrawn plan choices: tells the subscriber, refetches the
 * catalogue and forgets the choice, so the subscription asks for a plan again.
 *
 * Kept in the store, such a choice made the subscription unrenewable on every
 * later step: the review could not be priced, Back led to the gateway step, and
 * one more Back to a list saying nothing was renewable — with no control on it,
 * so the only way out was to leave /renew. `returnToPlanStep` is for steps past
 * plan selection; the subscription list offers "choose a plan" by itself.
 *
 * Returns true while releasing, so the caller shows its loader instead of
 * flashing the dead end it is about to leave. With `isCurrentStep: false` (a
 * step still mounted for its exit animation) it only reports; it never acts.
 */
function useReleaseWithdrawnPlanChoices(
  items: readonly RenewalOptionItem[] | undefined,
  {
    returnToPlanStep,
    isCurrentStep = true,
  }: { readonly returnToPlanStep: boolean; readonly isCurrentStep?: boolean },
): boolean {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedPlans, goBack } = useRenewalStore();
  const withdrawn = withdrawnPlanChoices(items, selectedPlans);
  const withdrawnKey = withdrawn.join("\u0000");
  // StrictMode re-runs the effect with the same closure; a second pass would
  // repeat the notice. The key resets once the choices are gone, so a later
  // withdrawal of a new choice still gets released.
  const releasedKey = useRef("");

  useEffect(() => {
    if (!isCurrentStep) return;
    if (withdrawnKey === releasedKey.current) return;
    releasedKey.current = withdrawnKey;
    if (withdrawn.length === 0) return;
    notifyPlanUnavailable(t);
    // Reset, not invalidate: the plan step would otherwise render the withdrawn
    // plan again while the catalogue refetches.
    void queryClient.resetQueries({ queryKey: ["plans"] });
    // The store has no action that forgets a single choice; this partial write
    // is the narrowest one that does.
    useRenewalStore.setState((state) => {
      const remaining = { ...state.selectedPlans };
      for (const subscriptionId of withdrawn) delete remaining[subscriptionId];
      return { selectedPlans: remaining };
    });
    if (returnToPlanStep) goBack("plan");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawnKey, isCurrentStep]);

  return withdrawn.length > 0;
}

/**
 * Selected subscriptions the panel now renews only onto a plan the subscriber
 * picks, with no pick made.
 *
 * Deleting a plan does that to every subscription on it: renewable, but
 * `requiresPlanSelection` and no price. Met on the review — the plan deleted
 * after the list was loaded, or between the review and Pay — such an item sat
 * in the list at "—", the total summed the others, and Pay was offered for it;
 * the panel refused every Pay, and nothing said a plan had to be chosen.
 */
function subscriptionsAwaitingPlanChoice(
  items: readonly RenewalOptionItem[] | undefined,
  selectedSubscriptionIds: readonly string[],
  selectedPlans: Record<string, string>,
): string[] {
  return (items ?? [])
    .filter(
      (item) =>
        selectedSubscriptionIds.includes(item.subscriptionId) &&
        item.requiresPlanSelection === true &&
        selectedPlans[item.subscriptionId] === undefined,
    )
    .map((item) => item.subscriptionId);
}

/**
 * Sends the review to plan selection for subscriptions that now need a plan,
 * telling the subscriber why. Returns true while doing so, so the review shows
 * its loader instead of the Pay it is about to take away. With
 * `isCurrentStep: false` it only reports; it never acts.
 *
 * `releasing` is the review's `useReleaseWithdrawnPlanChoices` flag for the
 * same answer. One answer can withdraw the plan chosen for one subscription and
 * find another's own plan deleted. The release then tells the subscriber and
 * returns them to plan selection in this same commit (letting go removes the
 * choice, so the flag is not up on any later one), and this adds only the
 * reload plan selection needs. Each used to act alone: the same notice twice,
 * and two returns to plan selection.
 */
function useSendToPlanChoice(
  items: readonly RenewalOptionItem[] | undefined,
  {
    isCurrentStep = true,
    releasing = false,
  }: { readonly isCurrentStep?: boolean; readonly releasing?: boolean } = {},
): boolean {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedSubscriptionIds, selectedPlans, goBack } = useRenewalStore();
  const awaiting = subscriptionsAwaitingPlanChoice(items, selectedSubscriptionIds, selectedPlans);
  const awaitingKey = awaiting.join("\u0000");
  // StrictMode re-runs the effect with the same closure; the notice must not
  // repeat. The review passes only an answer its visit received, which no
  // mount has yet, so that double run cannot meet one today. The latch stays
  // for a caller that hands this a cached copy.
  const sentKey = useRef("");

  useEffect(() => {
    if (!isCurrentStep) return;
    if (awaitingKey === sentKey.current) return;
    sentKey.current = awaitingKey;
    if (awaiting.length === 0) return;
    // Reset, not invalidate. Plan selection decides from the base renewal
    // options which subscriptions need a plan: on the cached copy, where this
    // one still had its own, it found none and skipped straight back to the
    // gateway and this review.
    void queryClient.resetQueries({ queryKey: ["renewal-options"] });
    if (releasing) return;
    notifyPlanUnavailable(t);
    // The catalogue is dropped for the same reason the other withdrawal paths
    // drop it.
    void queryClient.resetQueries({ queryKey: ["plans"] });
    goBack("plan");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingKey, isCurrentStep]);

  return awaiting.length > 0;
}

/**
 * A read a step cannot go on without failed, with nothing loaded to fall back
 * on. Retry needs no spinner of its own: a read with nothing loaded goes back to
 * pending when it starts again, and the step's loader takes over.
 */
function ReadFailed({
  message,
  onRetry,
  onBack,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-5 space-y-3">
      <TipCard tone="danger" role="alert">
        {message}
      </TipCard>
      <StadiumButton fullWidth variant="secondary" onClick={onRetry}>
        {t("common.retry")}
      </StadiumButton>
      <StadiumButton fullWidth variant="ghost" onClick={onBack}>
        {t("renewal.back")}
      </StadiumButton>
    </div>
  );
}

export default function RenewalPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const leave = useSafeBack("/dashboard");
  const { step, reset } = useRenewalStore();
  const { restricted } = useAccessMode();

  // Always start the wizard fresh on mount.
  useEffect(() => {
    return () => reset();
  }, [reset]);

  // A trial can't be renewed — the user must UPGRADE. Decide this up front,
  // using the AUTHORITATIVE per-subscription `renewable` flag, and bounce to
  // /upgrade BEFORE rendering any renewal chrome. Without this the user sees a
  // "Продление" screen flash before being redirected to "Улучшение". Both
  // queries share their keys with the wizard steps, so this adds no network.
  const {
    data: baseOptions,
    isLoading: optionsLoading,
    isError: optionsFailed,
    refetch: refetchOptions,
  } = useQuery({
    queryKey: ["renewal-options", {}, {}],
    queryFn: () => getRenewalOptions(),
    staleTime: 60_000,
  });
  const {
    data: subsData,
    isLoading: subsLoading,
    isError: subsFailed,
    refetch: refetchSubs,
  } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const decided = !optionsLoading && !subsLoading;
  // Only an answer says nothing is renewable. A read that failed, or one paused
  // while the device is offline, is not loading either, and holds no list: read
  // as "nothing renewable", it sent a subscriber holding any trial to /upgrade
  // from the middle of the wizard (the review's hand-off to plan selection
  // reloads this list), past plan selection's Retry and its offline wait. The
  // subscription list is history, so an expired trial kept beside a paid
  // subscription was enough. A refetch that failed still holds the list it did
  // not replace, and that is not taken for an answer either.
  const nothingRenewable =
    baseOptions !== undefined && !optionsFailed && baseOptions.items.every((o) => !o.renewable);
  const hasTrial = (subsData?.subscriptions ?? []).some((s) => s.isTrial);
  const redirectToUpgrade = decided && nothingRenewable && hasTrial;
  // The subscription step lists what these two reads say. With one of them
  // failed and nothing loaded, it says so instead of mounting the list. The list
  // presented the failure as «nothing to renew», and every new mount of it asked
  // again: this page swapped it for the loader while that read ran, and the
  // failure brought it back to ask once more, with no message and no Retry.
  const listUnreadable =
    (baseOptions === undefined && optionsFailed) || (subsData === undefined && subsFailed);
  const retryList = () => {
    if (optionsFailed) void refetchOptions();
    if (subsFailed) void refetchSubs();
  };

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

      {/* `checkout` and `polling` render the same child, so they must share a
          transition key. A changing key remounts it — a fresh `CheckoutStep`
          with a fresh ref latch AND a fresh `attemptId`, which would create a
          second draft under a second idempotency key. Today that is masked
          only because `setCheckoutResult` (which sets `polling`) and
          `navigate("/payment-return")` batch into one commit and the unmount
          wins the race; keying them together removes the dependency on that
          ordering. */}
      <StepTransition stepKey={step === "polling" ? "checkout" : step}>
        {step === "subscriptions" &&
          (listUnreadable ? (
            <ReadFailed message={t("renewal.loadError")} onRetry={retryList} onBack={leave} />
          ) : (
            <SelectSubscriptions />
          ))}
        {step === "plan" && <SelectPlan />}
        {step === "addons" && <SelectRenewalAddOns />}
        {step === "gateway" && <SelectGateway />}
        {step === "review" && <RenewalReview />}
        {(step === "checkout" || step === "polling") && <CheckoutStep />}
      </StepTransition>
    </div>
  );
}

function SelectSubscriptions() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const leave = useSafeBack("/dashboard");
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

  const {
    data: options,
    isError: optionsFailed,
    refetch: refetchOptions,
  } = useQuery({
    queryKey: ["renewal-options", selectedDurations, selectedPlans],
    queryFn: () =>
      getRenewalOptions({
        ...(durationsPayload.length > 0 ? { durations: durationsPayload } : {}),
        ...(plansPayload.length > 0 ? { plans: plansPayload } : {}),
      }),
    staleTime: 60_000,
  });
  const { data: subsData } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const releasing = useReleaseWithdrawnPlanChoices(options?.items, { returnToPlanStep: false });
  // The page answers for the subscriptions and the base list. A term or plan
  // picked here is read under a key of its own, and a failure of that read is
  // this step's to show: with nothing loaded it listed «nothing to renew».
  const optionsUnreadable = options === undefined && optionsFailed;
  // Not "isLoading": a read paused while the device is offline is neither
  // loading nor failed, and holds no list either.
  const isLoading = (options === undefined && !optionsFailed) || subsData === undefined || releasing;

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

  // Trial subscriptions can't be renewed — the user must UPGRADE to a regular
  // plan instead. Detect them so we can route to the upgrade flow.
  const trialSubs = (subsData?.subscriptions ?? []).filter((sub) => {
    const opt = optionById.get(sub.id);
    return sub.isTrial && (opt === undefined || !opt.renewable);
  });

  // Exactly one renewable subscription: select it for the subscriber, and skip
  // this step only when nothing is left to choose on it. A plan-less sub goes to
  // the tariff-selection step, which has its own term picker; a plan offering a
  // single term goes straight to the gateway. A plan offering several terms
  // STAYS here — the term picker below is the only place the term is chosen,
  // and skipping it renewed every such subscription for the default term.
  //
  // Once per visit: after that, an empty selection is the subscriber's own
  // untick, and re-selecting (or re-advancing) would undo it.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current) return;
    if (!isLoading && renewable.length === 1 && selectedSubscriptionIds.length === 0) {
      autoSelected.current = true;
      const only = renewable[0]!;
      setSelectedSubscriptions([only.sub.id]);
      if (only.option.requiresPlanSelection && !selectedPlans[only.sub.id]) setStep("plan");
      else if (only.option.availableDurations.length <= 1) setStep("gateway");
    }
  }, [isLoading, renewable, selectedSubscriptionIds.length, selectedPlans, setSelectedSubscriptions, setStep]);

  // Trying to renew but nothing is renewable and the user holds a trial →
  // send them to the upgrade flow (a trial is upgraded, never renewed). Only on
  // an answer, as on the page: a failed read lists nothing renewable too.
  const toUpgrade = !isLoading && !optionsFailed && renewable.length === 0 && trialSubs.length > 0;
  useEffect(() => {
    if (toUpgrade) navigate("/upgrade", { replace: true });
  }, [toUpgrade, navigate]);

  if (optionsUnreadable) {
    return <ReadFailed message={t("renewal.loadError")} onRetry={() => void refetchOptions()} onBack={leave} />;
  }

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="theme-skeleton h-20 animate-pulse rounded-2xl" />
        ))}
      </div>
    );
  }

  if (renewable.length === 0) {
    // Trials are being redirected to upgrade — render nothing to avoid a flash.
    if (toUpgrade) return null;
    // Surface the most relevant reason instead of a bare "none renewable".
    const reasonCode = (options?.items ?? [])
      .flatMap((i) => i.warnings.map((w) => w.code))
      .find((c) => RENEWAL_REASON_KEYS[c] !== undefined);
    const reason = reasonCode ? t(RENEWAL_REASON_KEYS[reasonCode]!) : null;
    return (
      <div className="px-5 space-y-2">
        <TipCard tone="info">{t("renewal.noneRenewable")}</TipCard>
        {reason && <p className="px-1 text-xs text-[color:var(--brand-muted-foreground)]">{reason}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-[color:var(--brand-muted-foreground)]">{t("renewal.selectSubtitle")}</p>
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
                  <p className="mb-1.5 text-xs text-[color:var(--brand-muted-foreground)]">{t("renewal.durationLabel")}</p>
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
                              ? "bg-(--brand-primary) text-(--brand-primary-fg)"
                              : "theme-surface-high text-[color:var(--brand-foreground)] hover:brightness-105"
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

  const {
    data: plansData,
    isError: plansFailed,
    refetch: refetchPlans,
  } = useQuery({
    queryKey: ["plans"],
    queryFn: getPlans,
    staleTime: 300_000,
  });
  const {
    data: baseOptions,
    isError: baseFailed,
    refetch: refetchBase,
  } = useQuery({
    queryKey: ["renewal-options", {}, {}],
    queryFn: () => getRenewalOptions(),
    staleTime: 60_000,
  });
  const { data: subsData } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const plans = plansData ?? [];

  const optionById = new Map((baseOptions?.items ?? []).map((o) => [o.subscriptionId, o]));
  const subById = new Map((subsData?.subscriptions ?? []).map((s) => [s.id, s]));
  // Only paid plans are valid renewal targets.
  const catalog = plans.filter((p) => !p.isTrial);
  const targets = selectedSubscriptionIds.filter(
    (id) => optionById.get(id)?.requiresPlanSelection ?? false,
  );
  // "Chosen" only counts once we actually know the targets (post-load).
  const allChosen = targets.length > 0 && targets.every((id) => Boolean(selectedPlans[id]));

  // Which subscriptions need a plan is decided from the base options, and only
  // from an answer. A read still loading, one paused while the device is
  // offline, and one that failed all leave them undefined. Read as "none needs
  // a plan", that skipped to the gateway, whose single-gateway auto-advance
  // re-entered the review that had just handed the subscriber over to this
  // step; a review still asking for a plan handed them over again, with another
  // notice, lap after lap.
  const optionsUnknown = baseOptions === undefined;
  // The catalogue matters only once there is a plan to choose.
  const catalogUnknown = plansData === undefined && targets.length > 0;
  const unreadable = (optionsUnknown && baseFailed) || (catalogUnknown && plansFailed);

  // Reached the plan step but nothing needs a tariff (e.g. all selected subs
  // already carry a plan) → skip straight to the gateway. Never strand here.
  useEffect(() => {
    if (!optionsUnknown && targets.length === 0) {
      setStep(selectedSubscriptionIds.length === 0 ? "subscriptions" : "gateway");
    }
  }, [optionsUnknown, targets.length, selectedSubscriptionIds.length, setStep]);

  if (unreadable) {
    return (
      <ReadFailed
        message={t("plans.empty")}
        onRetry={() => {
          if (baseFailed) void refetchBase();
          if (plansFailed) void refetchPlans();
        }}
        onBack={() => goBack("subscriptions")}
      />
    );
  }

  // Also while skipping: with no targets the effect above is already moving on.
  if (optionsUnknown || catalogUnknown || targets.length === 0) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="theme-skeleton h-16 animate-pulse rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="px-5 text-sm text-[color:var(--brand-muted-foreground)]">{t("renewal.choosePlanTitle")}</p>
      {targets.map((subId) => {
        const sub = subById.get(subId);
        const chosenPlanId = selectedPlans[subId];
        const chosenPlan = catalog.find((p) => String(p.id) === chosenPlanId);
        return (
          <div key={subId} className="space-y-2 px-5">
            {targets.length > 1 && sub && (
              <p className="text-xs font-medium text-[color:var(--brand-muted-foreground)]">{subscriptionTitle(sub)}</p>
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
                <p className="mb-1.5 text-xs text-[color:var(--brand-muted-foreground)]">{t("renewal.durationLabel")}</p>
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
                            ? "bg-(--brand-primary) text-(--brand-primary-fg)"
                            : "theme-surface-high text-[color:var(--brand-foreground)] hover:brightness-105",
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
    queryFn: ({ signal }) => getAddOnEntitlements({ signal }),
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
        <div className="theme-skeleton h-16 animate-pulse rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="px-5">
        <h2 className="text-base font-semibold">{t("renewal.reofferTitle")}</h2>
        <p className="mt-1 text-sm text-[color:var(--brand-muted-foreground)]">{t("renewal.reofferSubtitle")}</p>
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
      {title && <p className="text-xs font-medium text-[color:var(--brand-muted-foreground)]">{title}</p>}
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
                : "theme-surface theme-outline hover:brightness-105",
            )}
          >
            <div
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
                selected
                  ? "border-(--brand-primary) bg-(--brand-primary) text-(--brand-primary-fg)"
                  : "border-[color:var(--color-border-strong)]",
              )}
            >
              {selected && <Check className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-[color:var(--brand-foreground)]">{addOn.name}</p>
              <p className="text-xs text-[color:var(--brand-muted-foreground)]">
                {addOn.type === "EXTRA_TRAFFIC"
                  ? t("addons.extraTraffic", { value: addOn.value })
                  : t("addons.extraDevices", { count: addOn.value })}
              </p>
              {addOn.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-[color:var(--brand-muted-foreground)]">{addOn.description}</p>
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
  // While the saved cards are still being read, "no cards yet" looks exactly
  // like "no cards", and the auto-advance below skipped the card choice.
  const savedMethodsUnknown = yookassaEnabled && paymentMethodsPending;

  const choose = (
    gw: { type: string; displayName: string; currency: string },
    savedPaymentMethodId: string | null = null,
    autopay = false,
  ): void => {
    selectGateway({
      id: gw.type,
      label: autopay
        ? `${gatewayLabel(gw.type, gw.displayName)} · ${t("purchase.gateway.autopayCaption")}`
        : gatewayLabel(gw.type, gw.displayName),
      icon: GATEWAY_ICONS[gw.type] ?? "💳",
      currency: gw.currency,
      ...(autopay ? { autopay: true } : {}),
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
  // user has saved YooKassa methods so they can pick a card — decided once the
  // methods are known, not on the render before their read has answered. Nor
  // over a gateway offering «для автоматического списания»: a second option.
  useEffect(() => {
    if (
      !isLoading &&
      !policyLoading &&
      gateways.length === 1 &&
      gateways[0]!.autopay !== true &&
      navDirection === "forward" &&
      !savedMethodsUnknown &&
      savedYookassaMethods.length === 0
    ) {
      choose(gateways[0]!);
    }
  }, [isLoading, policyLoading, gateways, navDirection, savedMethodsUnknown, savedYookassaMethods.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <div key={i} className="theme-skeleton h-16 animate-pulse rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("purchase.gateway.title")}</h2>
      {savedYookassaMethods.length > 0 && (
        <div className="px-5 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-[color:var(--brand-muted-foreground)]">
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
                  <p className="truncate font-medium text-[color:var(--brand-foreground)]">
                    {formatSavedPaymentMethodTitle(method, t)}
                  </p>
                  <p className="text-xs text-[color:var(--brand-muted-foreground)]">
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
        {sorted.map((gw) => (
          <Fragment key={gw.type}>
            <button
              onClick={() => choose(gw)}
              className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
            >
              <GatewayIcon type={gw.type} currency={gw.currency} className="h-7 w-7" />
              <div className="text-left">
                <p className="font-medium text-[color:var(--brand-foreground)]">{gatewayLabel(gw.type, gw.displayName)}</p>
                <p className="text-xs text-[color:var(--brand-muted-foreground)]">{gw.currency}</p>
              </div>
            </button>
            {gw.autopay === true && (
              <button
                onClick={() => choose(gw, null, true)}
                className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
              >
                <AutopayGatewayMark type={gw.type} currency={gw.currency} />
                <div className="text-left">
                  <p className="font-medium text-[color:var(--brand-foreground)]">{gatewayLabel(gw.type, gw.displayName)}</p>
                  <p className="text-xs text-[color:var(--brand-muted-foreground)]">{t("purchase.gateway.autopayCaption")}</p>
                </div>
              </button>
            )}
          </Fragment>
        ))}
        {gateways.length === 0 && (
          <div className="py-8 text-center text-sm text-[color:var(--brand-muted-foreground)]">{t("purchase.gateway.empty")}</div>
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

/** The notice a held partner balance puts under its disabled button. */
const RENEWAL_BALANCE_HOLD_NOTICE_ID = "renewal-partner-balance-hold";

function RenewalReview() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    step,
    selectedSubscriptionIds,
    selectedDurations,
    selectedPlans,
    selectedAddOns,
    selectedGateway,
    selectedSavedPaymentMethodId,
    setReviewQuote,
    setStep,
    goBack,
  } = useRenewalStore();
  // StepTransition keeps a step it is leaving mounted for the exit animation
  // (about 200 ms), and that copy keeps re-rendering from the store. A review
  // leaving for plan selection saw the choice it had just released dropped
  // under it, priced what was left, and handed the subscriber over a second
  // time on that answer. It asks for a price, and acts on one, only while it is
  // the step on screen.
  const isCurrentStep = step === "review";
  // Picking «для автоматического списания» is the customer's consent to save
  // the method; this says what that consent means before they pay.
  const showAutopayNotice = selectedGateway?.autopay === true && !selectedSavedPaymentMethodId;

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
    isPaused,
    isFetchedAfterMount,
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
    enabled: isCurrentStep && selectedSubscriptionIds.length > 0 && !!selectedGateway,
    // Priced again on every visit. The cached copy is what this review said
    // last time, and a visit can follow the very hand-off that copy caused: sent
    // to plan selection, the subscriber finds nothing to choose there (a plan
    // was put back on sale, say), the single gateway advances, and the copy,
    // fresh for 30 s, asked for a plan once more.
    refetchOnMount: "always",
  });
  // Only an answer this visit received decides a hand-off. Until the re-price
  // lands, `data` is the copy it replaces; after a failed one it is still that
  // copy, which nothing confirmed.
  const answeredItems = isFetchedAfterMount && !error ? data?.items : undefined;
  // A leaving review still reports what it is doing, so it keeps the loader it
  // showed while handing off, but never acts again.
  const releasing = useReleaseWithdrawnPlanChoices(answeredItems, { returnToPlanStep: true, isCurrentStep });
  const choosingPlan = useSendToPlanChoice(answeredItems, { isCurrentStep, releasing });
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
      markPushPromptEligible();
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
      toast.error(t("renewal.balanceError"));
    },
  });
  const balanceHold = standingBalanceHold(partner?.balanceHold);

  // Offline, the re-price this visit starts is paused, not running: neither
  // loading nor fetching, with `data` still the copy an earlier visit left, or
  // nothing. Pay on that copy was never confirmed, and "cannot calculate the
  // price" is not true either, so the review waits for the connection. A
  // leaving review whose selection changed under it has no answer of its own
  // to show and keeps the loader through its exit: what is cached for its new
  // selection is what an earlier visit said, a price error included.
  if (
    isLoading ||
    isFetching ||
    isPaused ||
    (!isCurrentStep && !isFetchedAfterMount) ||
    addOnReview.status === "PENDING" ||
    releasing ||
    choosingPlan
  ) {
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
                <p className="truncate font-mono font-medium text-[color:var(--brand-foreground)]">{title}</p>
                {subtitle && <p className="truncate text-xs text-[color:var(--brand-muted-foreground)]">{subtitle}</p>}
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
              <p className="truncate text-[color:var(--brand-foreground)]">{addOn.name}</p>
              <p className="truncate text-xs text-[color:var(--brand-muted-foreground)]">
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

      {showAutopayNotice && (
        <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-4 py-3 text-sm leading-snug text-[color:var(--brand-foreground)]">
          <p className="font-medium text-[color:var(--brand-foreground)]">{t("purchase.quote.autopayTitle")}</p>
          <p className="mt-0.5 text-xs text-[color:var(--brand-muted-foreground)]">{t("purchase.quote.autopayHint")}</p>
        </div>
      )}

      {/* One renewal, one payment. The balance pays in place with this review
          still on screen, and Pay stayed live beside it: while that payment was
          out, and after it went through, Pay created a gateway checkout for the
          same renewal. So Pay takes no tap while a balance payment is out or
          done; a failed one gives it back. Neither button takes one once this
          review is not the step on screen: it stays mounted for its exit, and a
          review leaving for checkout still paid from the balance. */}
      <StadiumButton
        fullWidth
        size="lg"
        glow
        icon={<Check className="h-5 w-5" />}
        disabled={!isCurrentStep || balanceMutation.isPending || balanceMutation.isSuccess}
        onClick={() => {
          setReviewQuote({ amount: confirmedAmount, currency: confirmedCurrency });
          setStep("checkout");
        }}
      >
        {t("renewal.pay")}
      </StadiumButton>
      {/* On hold after a password recovery the balance is still offered — so
          the subscriber sees which option it is — but it takes no tap, and the
          notice under it says for how long and why. */}
      {balanceEligible && balanceItem && partner && (
        <>
          <StadiumButton
            fullWidth
            variant="secondary"
            loading={balanceMutation.isPending}
            disabled={!isCurrentStep || balanceMutation.isSuccess || balanceHold !== null}
            aria-describedby={balanceHold ? RENEWAL_BALANCE_HOLD_NOTICE_ID : undefined}
            onClick={() => balanceMutation.mutate(balanceItem)}
          >
            {t("renewal.payWithBalance", {
              amount: (partner.balance / 100).toFixed(2),
              currency: partner.balanceCurrency,
            })}
          </StadiumButton>
          {balanceHold && (
            <PartnerBalanceHoldNotice hold={balanceHold} id={RENEWAL_BALANCE_HOLD_NOTICE_ID} />
          )}
        </>
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
  const queryClient = useQueryClient();

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
      // Stash the URL first: `startCheckoutRedirect` cannot navigate inside a
      // Telegram Mini App (no gesture on this path), so the buyer finishes from
      // the button on the return page — and that button needs this URL.
      savePendingCheckout(result.paymentId, result.checkoutUrl ?? null, { returnTo: "/renew" });
      if (result.checkoutUrl) startCheckoutRedirect(result.checkoutUrl);
      navigate(`/payment-return?paymentId=${result.paymentId}`, { replace: true });
    },
    onError: () => {
      // A refused checkout means the reviewed quote may no longer hold — the
      // chosen plan withdrawn, or the price changed (`QUOTE_CHANGED`). Re-price
      // it on the way back: still fresh for 30 s, the review re-offered the
      // refused quote with the same Pay button, and paying failed the same way.
      void queryClient.invalidateQueries({ queryKey: ["renewal-review"] });
      // Return to review (not a stuck spinner) so the user can retry.
      toast.error(t("renewal.checkoutError"));
      goBack("review");
    },
  });

  // A ref, not the mutation flags: StrictMode runs setup → cleanup → setup
  // with no re-render in between, and React Query publishes state through a
  // `setTimeout`, so the second setup still reads `isPending: false` and fires
  // a second draft (two `savePendingCheckout` + `startCheckoutRedirect` +
  // `navigate` runs). Refs survive the simulated remount; this latch does not.
  // The latch is per mount, so `attemptId` still pairs 1:1 with it — a genuine
  // retry remounts this step from `review` and mints a fresh key.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutation.mutate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4" role="status" aria-live="polite">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-[color:var(--brand-muted-foreground)]">{t("renewal.creating")}</p>
    </div>
  );
}
