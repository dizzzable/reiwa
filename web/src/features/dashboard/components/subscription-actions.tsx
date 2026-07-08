/**
 * SubscriptionActions
 * ───────────────────
 * Row of three icon+label action buttons directly below the subscription card.
 * These are actions **on the current subscription**:
 *   - Connect (Link2) — opens the subscription URL (deep-links into the VPN
 *     client / subscription page) instead of copying it.
 *   - Upgrade (ArrowUpCircle) — navigates to plans with upgrade intent
 *   - Renew (RotateCcw) — navigates to plans with renew intent
 *
 * Buy and Promo live in the page header (top-right corner icons) since they
 * are global actions not tied to a specific subscription card.
 */

import { ArrowUpCircle, Link2, Plus, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import type { Subscription } from "@/types/api";
import { getPlanAddOns } from "@/lib/api-client";
import { openExternalUrl } from "@/lib/utils";

interface SubscriptionActionsProps {
  subscription: Subscription | null;
  onConnect: () => void;
  onUpgrade: () => void;
  onRenew: () => void;
  /** Upgrade / top-up are new purchases — disable under PURCHASE_BLOCKED / RESTRICTED. */
  purchasesBlocked?: boolean;
  /** RESTRICTED freezes the whole money path, including renewal. */
  restricted?: boolean;
}

export function SubscriptionActions({
  subscription,
  onConnect,
  onUpgrade,
  onRenew,
  purchasesBlocked = false,
  restricted = false,
}: SubscriptionActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  // A FREE trial can't be renewed — only upgraded to a paid plan — so the
  // Renew action is disabled for it (the user is steered to Upgrade instead).
  // Paid trials stay renewable.
  const isFreeTrial = sub?.isTrial === true && sub?.trialFree === true;

  // Top-up (докупка) is only meaningful when the plan actually has add-on
  // options configured. Fetch the same per-plan catalog the /addons page uses
  // (shared React Query cache key) and disable the button when it resolves
  // empty — so the user never lands on a dead-end "no add-ons" screen. Mirrors
  // the /addons page's own EXTRA_TRAFFIC-on-unlimited filter. Enabled only for
  // an active, purchasable subscription (the same gate the button already has).
  const planId = sub?.plan?.id ?? null;
  const isUnlimitedTraffic = sub?.trafficLimit === null;
  const { data: addOns } = useQuery({
    queryKey: ["add-ons", planId],
    queryFn: () => getPlanAddOns(planId ?? ""),
    enabled: isActive && !purchasesBlocked && planId !== null,
    staleTime: 60_000,
  });
  const noAddOnsAvailable =
    addOns !== undefined &&
    addOns.filter((a) => !(isUnlimitedTraffic && a.type === "EXTRA_TRAFFIC")).length === 0;

  return (
    <div className="mt-5 grid grid-cols-4 gap-2 px-5">
      <ActionButton
        icon={<Link2 className="h-5 w-5" />}
        label={t("card.actions.connect")}
        disabled={!hasUrl}
        onClick={() => {
          if (sub?.url) {
            openExternalUrl(sub.url);
            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
          }
          onConnect();
        }}
      />
      <ActionButton
        icon={<ArrowUpCircle className="h-5 w-5" />}
        label={t("card.actions.upgrade")}
        disabled={!canRenewOrUpgrade || purchasesBlocked}
        onClick={onUpgrade}
      />
      <ActionButton
        icon={<RotateCcw className="h-5 w-5" />}
        label={t("card.actions.renew")}
        disabled={!canRenewOrUpgrade || restricted || isFreeTrial}
        onClick={onRenew}
      />
      <ActionButton
        icon={<Plus className="h-5 w-5" />}
        label={t("card.actions.topUp")}
        disabled={!isActive || purchasesBlocked || noAddOnsAvailable}
        onClick={() => navigate("/addons")}
      />
    </div>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1.5 rounded-2xl border border-white/6 bg-white/3 px-1 py-3 transition-all duration-150 active:scale-95 disabled:opacity-40 disabled:pointer-events-none hover:bg-white/6"
    >
      <span className="text-(--brand-primary)">{icon}</span>
      <span className="w-full truncate px-0.5 text-center text-[10.5px] font-medium text-zinc-300">{label}</span>
    </button>
  );
}
