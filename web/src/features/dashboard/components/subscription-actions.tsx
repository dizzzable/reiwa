/**
 * SubscriptionActions
 * ───────────────────
 * Row of three icon+label action buttons directly below the subscription card.
 * These are actions **on the current subscription**:
 *   - Connect (Link2) — copies the subscription URL to clipboard
 *   - Upgrade (ArrowUpCircle) — navigates to plans with upgrade intent
 *   - Renew (RotateCcw) — navigates to plans with renew intent
 *
 * Buy and Promo live in the page header (top-right corner icons) since they
 * are global actions not tied to a specific subscription card.
 */

import { useState } from "react";
import { ArrowUpCircle, Link2, Plus, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { Subscription } from "@/types/api";
import { AddOnsSheet } from "./addons-sheet";

interface SubscriptionActionsProps {
  subscription: Subscription | null;
  onConnect: () => void;
  onUpgrade: () => void;
  onRenew: () => void;
}

export function SubscriptionActions({
  subscription,
  onConnect,
  onUpgrade,
  onRenew,
}: SubscriptionActionsProps) {
  const { t } = useTranslation();
  const [addOnsOpen, setAddOnsOpen] = useState(false);
  const sub = subscription;
  const hasUrl = !!sub?.url;
  const isActive = sub?.status === "ACTIVE" || sub?.status === "LIMITED";

  return (
    <>
      <div className="mt-5 grid grid-cols-4 gap-3 px-5">
        <ActionButton
          icon={<Link2 className="h-5 w-5" />}
          label={t("card.actions.connect")}
          disabled={!hasUrl}
          onClick={() => {
            if (sub?.url) {
              navigator.clipboard.writeText(sub.url);
              toast.success(t("common.copied"));
              window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
            }
            onConnect();
          }}
        />
        <ActionButton
          icon={<ArrowUpCircle className="h-5 w-5" />}
          label={t("card.actions.upgrade")}
          disabled={!isActive}
          onClick={onUpgrade}
        />
        <ActionButton
          icon={<RotateCcw className="h-5 w-5" />}
          label={t("card.actions.renew")}
          disabled={!isActive}
          onClick={onRenew}
        />
        <ActionButton
          icon={<Plus className="h-5 w-5" />}
          label={t("card.actions.topUp")}
          disabled={!isActive}
          onClick={() => setAddOnsOpen(true)}
        />
      </div>

      {sub && isActive && (
        <AddOnsSheet open={addOnsOpen} onOpenChange={setAddOnsOpen} subscription={sub} />
      )}
    </>
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
      className="flex flex-col items-center gap-1.5 rounded-2xl border border-white/6 bg-white/3 py-3 transition-all duration-150 active:scale-95 disabled:opacity-40 disabled:pointer-events-none hover:bg-white/6"
    >
      <span className="text-(--brand-primary)">{icon}</span>
      <span className="text-[11px] font-medium text-zinc-300">{label}</span>
    </button>
  );
}
