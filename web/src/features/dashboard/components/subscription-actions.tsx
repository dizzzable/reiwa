/**
 * SubscriptionActions
 * ───────────────────
 * Row of three icon+label action buttons directly below the subscription card.
 * These are actions **on the current subscription**:
 *   - Connect (Link2) — raises `onConnect`; the page decides what connecting
 *     means (today: opens the subscription URL instead of copying it).
 *   - Upgrade (ArrowUpCircle) — navigates to plans with upgrade intent
 *   - Renew (RotateCcw) — navigates to plans with renew intent
 *
 * Buy and Promo live in the page header (top-right corner icons) since they
 * are global actions not tied to a specific subscription card.
 */

import { ArrowUpCircle, Link2, Plus, RotateCcw } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import type { Subscription } from "@/types/api";
import { getSubscriptionAddOns } from "@/lib/api-client";
import {
  canRenewSubscription,
  invokeRenewSubscriptionAction,
} from "./subscription-action-policy";

interface SubscriptionActionsProps {
  subscription: Subscription | null;
  onConnect: () => void;
  onUpgrade: () => void;
  onRenew: () => void;
  /** Upgrade / top-up are new purchases — disable under PURCHASE_BLOCKED / RESTRICTED. */
  purchasesBlocked?: boolean;
  /** RESTRICTED freezes the whole money path, including renewal. */
  restricted?: boolean;
  /** Authoritative action policy for this exact subscription id. */
  policyCanRenew?: boolean;
  /** A transient presentation (for example deletion) owns the card. */
  disabled?: boolean;
}

export function SubscriptionActions({
  subscription,
  onConnect,
  onUpgrade,
  onRenew,
  purchasesBlocked = false,
  restricted = false,
  policyCanRenew,
  disabled = false,
}: SubscriptionActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const renewalReasonId = useId();
  const sub = subscription;
  const hasUrl = !!sub?.url;
  const isActive = sub?.status === "ACTIVE" || sub?.status === "LIMITED";
  // Renewing/upgrading an EXPIRED subscription is explicitly supported by the
  // backend (it only excludes DELETED subscriptions from renewal/upgrade
  // eligibility) — an expired sub is exactly the case a user most needs to
  // renew. Top-up (add-ons) stays gated on `isActive`: it raises limits on a
  // LIVE Remnawave profile, which the backend rejects outright once expired.
  const canRenewOrUpgrade =
    sub?.status === "ACTIVE" || sub?.status === "LIMITED" || sub?.status === "EXPIRED";
  const canRenew = canRenewSubscription(sub, restricted, policyCanRenew);
  const trialRenewalReason =
    sub?.isTrial === true ? t("renewal.reason.trial") : null;

  // Top-up (докупка) is only meaningful when the subscription actually has
  // eligible add-on options. Query the SAME v2 subscription-scoped eligibility
  // the /addons wizard uses (shared React Query cache key) and disable the
  // button when it resolves to zero eligible add-ons — so the user never lands
  // on a dead-end "no add-ons" screen. The backend gates finite-baseline +
  // plan applicability server-side, so there is no client-side limit filter to
  // keep in sync. Enabled only for an active, purchasable subscription.
  const { data: eligibility } = useQuery({
    queryKey: ["add-ons-eligibility", sub?.id ?? null],
    queryFn: () => getSubscriptionAddOns(sub?.id ?? ""),
    enabled: isActive && !purchasesBlocked && !!sub?.id,
    staleTime: 60_000,
  });
  const noAddOnsAvailable = eligibility !== undefined && eligibility.addOns.length === 0;

  return (
    <div className="mt-5 grid grid-cols-4 gap-2 px-5">
      <ActionButton
        icon={<Link2 className="h-5 w-5" />}
        label={t("card.actions.connect")}
        disabled={disabled || !hasUrl}
        // Signals the intent and nothing else. Opening the link used to happen
        // HERE as well as in the parent's `onConnect`, so one tap opened the
        // same URL twice and fired two haptics — invisible in Telegram, which
        // swallows the second `openLink`, and a stray second tab in a browser.
        // The parent owns the action because the parent is where "outside vs
        // inside the cabinet" will be decided.
        onClick={onConnect}
      />
      <ActionButton
        icon={<ArrowUpCircle className="h-5 w-5" />}
        label={t("card.actions.upgrade")}
        disabled={disabled || !canRenewOrUpgrade || purchasesBlocked}
        onClick={onUpgrade}
      />
      <ActionButton
        icon={<RotateCcw className="h-5 w-5" />}
        label={t("card.actions.renew")}
        disabled={disabled || !canRenew}
        ariaDescribedBy={trialRenewalReason ? renewalReasonId : undefined}
        onClick={() => {
          invokeRenewSubscriptionAction({
            subscription: sub,
            restricted,
            policyCanRenew,
            onRenew,
          });
        }}
      />
      <ActionButton
        icon={<Plus className="h-5 w-5" />}
        label={t("card.actions.topUp")}
        disabled={
          disabled || !isActive || purchasesBlocked || noAddOnsAvailable
        }
        onClick={() =>
          navigate(sub?.id ? `/addons?subscriptionId=${encodeURIComponent(sub.id)}` : "/addons")
        }
      />
      {trialRenewalReason ? (
        <p
          id={renewalReasonId}
          role="note"
          className="col-span-4 px-1 pt-1 text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]"
        >
          {trialRenewalReason}
        </p>
      ) : null}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  onClick,
  ariaDescribedBy,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  ariaDescribedBy?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-describedby={ariaDescribedBy}
      className="flex flex-col items-center gap-1.5 rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-1 py-3 transition-all duration-150 hover:bg-[color:var(--color-surface-high)] active:scale-95 disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="text-(--brand-primary)">{icon}</span>
      <span className="w-full truncate px-0.5 text-center text-[10.5px] font-medium text-[color:var(--brand-foreground)]">{label}</span>
    </button>
  );
}
