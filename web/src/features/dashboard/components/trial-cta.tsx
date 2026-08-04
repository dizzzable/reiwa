/**
 * TrialCta
 * ────────
 * Shown in the dashboard empty-state when the user has completed the claim and
 * has NO active subscription. Two shapes (Property 5):
 *   - free trial eligible → "Try for free" → activates via `activateTrial()`
 *     and, on success, calls `onActivated` so the real tutorial can run.
 *   - a paid trial plan exists → "Try for {price}" → routes to the purchase
 *     flow for that plan (the price comes from the plan catalog).
 * Renders nothing when no trial is configured / the user isn't eligible and
 * there's no paid trial plan — the buy CTA then stands alone.
 *
 * Web throttling (Property 11): the offer is surfaced at most once per
 * `WEB_OFFER_THROTTLE_MS`; the bot button is NOT throttled (handled in the
 * bot keyboard). Dismissing records `trialDeclined` so the demo tutorial can
 * run instead (Property 8, wired in the tutorial wave).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Gift, Loader2 } from "lucide-react";

import { activateTrial, getPlans, getTrialEligibility } from "@/lib/api-client";
import { useBranding } from "@/lib/branding-provider";
import { usePurchaseStore } from "@/stores/purchase.store";
import { useOnboardingContext } from "@/features/onboarding/onboarding-tour-controller";
import { writeOnboardingPrefs } from "@/lib/onboarding-prefs";
import type { Plan } from "@/types/api";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
};

/** Number of staged reassurance messages shown while the trial provisions. */
const TRIAL_ACTIVATION_STEP_COUNT = 4;

/**
 * Server reasons that mean "this user will never get a free trial from here".
 * On these the offer is withdrawn instead of showing a retry: the block used to
 * stay up with one generic error, so a user whose trial was already used kept
 * pressing a button that could not succeed — and, worse, was shown an offer they
 * were never entitled to.
 */
const INELIGIBLE_REASONS = new Set([
  'TRIAL_ALREADY_USED',
  'ALREADY_HAS_SUBSCRIPTION',
  'TRIAL_NOT_CONFIGURED',
  'TRIAL_REQUIRES_PAYMENT',
  'TRIAL_INVITED_ONLY',
  'INELIGIBLE',
]);

/** Reason → message key, so the cause is named instead of hidden. */
const REASON_MESSAGE_KEYS: Record<string, string> = {
  TRIAL_ALREADY_USED: 'trialCta.errorAlreadyUsed',
  ALREADY_HAS_SUBSCRIPTION: 'trialCta.errorHasSubscription',
  TRIAL_NOT_CONFIGURED: 'trialCta.errorNotConfigured',
  TRIAL_REQUIRES_PAYMENT: 'trialCta.errorRequiresPayment',
  TRIAL_INVITED_ONLY: 'trialCta.errorInvitedOnly',
};

interface TrialEligibility {
  eligible: boolean;
  reason: string | null;
}

function lowestPrice(
  plan: Plan,
  preferredCurrency: string,
): { amount: number; currency: string } | null {
  const all = plan.durations.flatMap((d) =>
    d.prices.map((p) => ({ amount: Number(p.price), currency: p.currency })),
  );
  if (!all.length) return null;
  const preferred = all.filter((p) => p.currency === preferredCurrency);
  const usd = all.filter((p) => p.currency === "USD");
  const list = preferred.length ? preferred : usd.length ? usd : all;
  return list.reduce((min, p) => (p.amount < min.amount ? p : min), list[0]);
}

interface TrialCtaProps {
  /** IDs that existed before this Trial request starts. */
  readonly knownSubscriptionIds: readonly string[];
  /** Starts the dashboard handoff, even when a legacy response omits its ID. */
  onActivated: (
    subscriptionId: string | undefined,
    knownSubscriptionIds: readonly string[],
  ) => void;
}

export function TrialCta({ knownSubscriptionIds, onActivated }: TrialCtaProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { defaultCurrency } = useBranding();
  const { selectPlan } = usePurchaseStore();
  const { startDemo } = useOnboardingContext();

  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Set when the server refuses on a ground that a retry cannot change.
  const [ineligible, setIneligible] = useState(false);
  // Staged progress messages during activation. Provisioning a Remnawave
  // profile can take several seconds; a rotating status keeps the user informed
  // (and reassured it isn't stuck) instead of a bare, ambiguous "Activating…".
  const [activationStep, setActivationStep] = useState(0);
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    },
    [],
  );

  const { data: eligibility } = useQuery<TrialEligibility>({
    queryKey: ["trial", "eligibility"],
    queryFn: getTrialEligibility as () => Promise<TrialEligibility>,
    staleTime: 60_000,
    retry: false,
  });

  const { data: plans = [] } = useQuery<Plan[]>({
    queryKey: ["plans"],
    queryFn: getPlans,
    staleTime: 300_000,
    retry: false,
  });

  // `ineligible` is a local shortcut so the offer disappears immediately on a
  // refusal, ahead of the refetch. It must not outlive the server's answer: when
  // eligibility says yes again (the operator configured the missing duration, a
  // blocking subscription is gone), the shortcut has to step aside or the offer
  // stays hidden until a full reload.
  useEffect(() => {
    if (eligibility?.eligible === true) setIneligible(false);
  }, [eligibility?.eligible]);

  const trialPlan = useMemo(() => plans.find((p) => p.isTrial), [plans]);
  const freeEligible = eligibility?.eligible === true;
  const paidTrial = trialPlan !== undefined && trialPlan.trialFree === false;
  // The trial requires a linked Telegram account (free-trial path returns this
  // reason for a web-only user). Steer them to the linking flow instead of
  // silently hiding the offer.
  const needsTelegramLink =
    eligibility?.reason === "TRIAL_REQUIRES_TELEGRAM" && !freeEligible && !paidTrial;
  // The dashboard renders this only in the empty-state (no active subscription),
  // where the trial offer IS the primary action — so it is shown whenever the
  // user is eligible, mirroring the always-visible bot trial button. (We do not
  // throttle here: throttling left subscription-less users with only a "Buy"
  // button while the bot still offered the trial.)
  const visible =
    !dismissed && !ineligible && (freeEligible || paidTrial || needsTelegramLink);

  if (!visible) return null;

  const price = paidTrial && trialPlan ? lowestPrice(trialPlan, defaultCurrency) : null;
  const priceLabel = price
    ? `${CURRENCY_SYMBOLS[price.currency] ?? ""}${price.amount.toFixed(2)}`
    : "";

  async function handleActivate() {
    if (needsTelegramLink) {
      // Same contract as the linking quests: this button says "link Telegram",
      // so open that form directly instead of leaving the user on the privacy
      // list to find the row themselves.
      navigate("/settings/privacy?link=telegram");
      return;
    }
    if (paidTrial && trialPlan) {
      selectPlan(trialPlan);
      navigate("/purchase");
      return;
    }
    setActivating(true);
    setError(null);
    setActivationStep(0);
    // Advance the reassurance message up to the last step and hold there.
    stepTimerRef.current = setInterval(() => {
      setActivationStep((step) => Math.min(step + 1, TRIAL_ACTIVATION_STEP_COUNT - 1));
    }, 2200);
    try {
      const result = await activateTrial();
      const subscriptionId = result.subscriptionId?.trim();
      if (!result.activated) {
        const reason = result.reason ?? '';
        if (INELIGIBLE_REASONS.has(reason)) {
          // Withdraw the offer and re-read eligibility: the server has just told
          // us this user is not entitled, so keeping a retry button on screen
          // would only reproduce the same failure.
          //
          // The reason goes to a toast rather than into `error`, because this
          // block is about to unmount itself — an in-card message would be
          // painted for one frame and then vanish along with it, which reads as
          // the offer silently disappearing mid-spinner.
          setActivating(false);
          toast.error(t(REASON_MESSAGE_KEYS[reason] ?? "trialCta.errorGeneric"));
          setIneligible(true);
          await queryClient.invalidateQueries({ queryKey: ["trial", "eligibility"] });
          return;
        }
        setActivating(false);
        setError(t(REASON_MESSAGE_KEYS[reason] ?? "trialCta.errorGeneric"));
        // A reason we do not recognise is treated as retryable, so the cached
        // eligibility must still be refreshed — otherwise the block keeps
        // offering a trial the server has just refused for up to a minute.
        await queryClient.invalidateQueries({ queryKey: ["trial", "eligibility"] });
        return;
      }
      // Some deployed Rezeis versions acknowledge the grant before they
      // include the ID. The receipt resolves the newly appeared trial row on
      // the next canonical list fetch instead of ever showing `Ожидает`.
      onActivated(subscriptionId || undefined, knownSubscriptionIds);
      await queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
      // The claim has just been spent. Nothing else in the app refreshes this
      // key, and it is cached for a minute — leaving it means a user who
      // activates and then deletes the trial is offered it again.
      await queryClient.invalidateQueries({ queryKey: ["trial", "eligibility"] });
    } catch {
      setActivating(false);
      setError(t("trialCta.errorGeneric"));
    } finally {
      if (stepTimerRef.current) {
        clearInterval(stepTimerRef.current);
        stepTimerRef.current = null;
      }
    }
  }

  function handleDismiss() {
    writeOnboardingPrefs({ trialDeclined: true });
    setDismissed(true);
    // Declining the trial still teaches the user via the demo tutorial
    // (Property 8) — they learn the cabinet on clearly-labeled sample data.
    startDemo();
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", damping: 20 }}
      className="mx-5 mb-4 flex flex-col items-center rounded-[var(--radius-card)] border border-(--brand-primary)/25 bg-(--brand-primary)/[0.06] p-7 text-center"
    >
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
        style={{ backgroundColor: "color-mix(in oklab, var(--brand-primary) 18%, transparent)" }}
      >
        <Gift className="h-7 w-7" style={{ color: "var(--brand-primary)" }} />
      </div>
      <h2 className="text-lg font-semibold text-[color:var(--brand-foreground)]">
        {needsTelegramLink
          ? t("trialCta.titleLinkTelegram")
          : paidTrial
            ? t("trialCta.titlePaid")
            : t("trialCta.titleFree")}
      </h2>
      <p className="mt-1 text-sm text-[color:var(--brand-muted-foreground)]">
        {needsTelegramLink
          ? t("trialCta.subtitleLinkTelegram")
          : paidTrial
            ? t("trialCta.subtitlePaid")
            : t("trialCta.subtitleFree")}
      </p>

      {error && (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      <button
        onClick={handleActivate}
        disabled={activating}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {activating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("trialCta.activating")}
          </>
        ) : needsTelegramLink ? (
          <>
            <Gift className="h-4 w-4" />
            {t("trialCta.buttonLinkTelegram")}
          </>
        ) : paidTrial ? (
          t("trialCta.buttonPaid", { price: priceLabel })
        ) : (
          <>
            <Gift className="h-4 w-4" />
            {t("trialCta.buttonFree")}
          </>
        )}
      </button>

      {activating && (
        <p className="mt-3 text-xs text-[color:var(--brand-muted-foreground)]" aria-live="polite">
          {t(`trialCta.activationSteps.${activationStep}`)}
        </p>
      )}

      <button
        onClick={handleDismiss}
        disabled={activating}
        className="mt-3 text-xs text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)] disabled:opacity-50"
      >
        {t("trialCta.dismiss")}
      </button>
    </motion.div>
  );
}
