/**
 * SubscriptionCard
 * ────────────────
 * Bank-card-style visual for a single subscription. Displays:
 *   - Plan name (top-left, like card brand)
 *   - Status badge (top-right)
 *   - Subscription profile name / remnawave ID (center, like card number)
 *   - Expiry date (bottom-left, like card expiry)
 *   - First connected device (bottom-right)
 *   - Traffic progress bar (bottom)
 *
 * The card background uses `--brand-card-gradient` and `--brand-card-pattern`
 * CSS variables set by the BrandingProvider, so the operator's palette is
 * applied automatically.
 */

import { useTranslation } from "react-i18next";
import { Wifi, WifiOff } from "lucide-react";

import { cn, formatDate } from "@/lib/utils";
import type { Subscription } from "@/types/api";

interface SubscriptionCardProps {
  subscription: Subscription;
  /** First device name to show on the card face. */
  firstDevice?: string | null;
}

export function SubscriptionCard({ subscription, firstDevice }: SubscriptionCardProps) {
  const { t } = useTranslation();
  const sub = subscription;

  const isActive = sub.status === "ACTIVE" || sub.status === "LIMITED";
  const statusLabel = isActive
    ? t("card.activeStatus")
    : sub.status === "EXPIRED"
      ? t("card.expiredStatus")
      : t("card.pendingStatus");

  // Traffic progress (0–1). When unlimited, show full bar.
  const trafficUsedGb = sub.trafficUsed ?? null;
  const trafficTotalGb = sub.trafficLimit ?? null;
  const trafficProgress =
    trafficTotalGb !== null && trafficTotalGb > 0 && trafficUsedGb !== null
      ? Math.min(trafficUsedGb / trafficTotalGb, 1)
      : null;

  return (
    <div
      className={cn(
        "brand-card relative flex h-[200px] w-full flex-col justify-between p-5 text-white select-none",
        "shadow-xl shadow-black/30",
      )}
    >
      {/* Top row: plan name + status */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          {isActive ? (
            <Wifi className="h-4 w-4 opacity-80" />
          ) : (
            <WifiOff className="h-4 w-4 opacity-60" />
          )}
          <span className="text-sm font-semibold opacity-90 truncate max-w-[160px]">
            {sub.plan?.name ?? "Subscription"}
          </span>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            isActive
              ? "bg-white/20 text-white"
              : "bg-black/30 text-white/70",
          )}
        >
          {statusLabel}
        </span>
      </div>

      {/* Center: profile ID (like card number) */}
      <div className="flex-1 flex items-center">
        <p className="font-mono text-lg tracking-wider opacity-80 truncate">
          {sub.userRemnaId || sub.id}
        </p>
      </div>

      {/* Bottom row: expiry + first device */}
      <div className="space-y-2">
        {/* Traffic bar */}
        {trafficProgress !== null ? (
          <div className="space-y-1">
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-white/70 transition-all duration-500"
                style={{ width: `${trafficProgress * 100}%` }}
              />
            </div>
            <p className="text-[10px] uppercase tracking-wider opacity-60">
              {t("card.trafficUsed")}: {trafficUsedGb} / {trafficTotalGb} GB
            </p>
          </div>
        ) : trafficTotalGb === null ? (
          <p className="text-[10px] uppercase tracking-wider opacity-60">
            {t("card.trafficUnlimited")}
          </p>
        ) : null}

        <div className="flex items-end justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider opacity-60">
              {t("card.expiresOn")}
            </p>
            <p className="text-sm font-semibold">{formatDate(sub.expiresAt ?? sub.expireAt)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider opacity-60">
              {t("card.firstDevice")}
            </p>
            <p className="text-sm font-medium truncate max-w-[120px]">
              {firstDevice ?? t("card.noDevicesYet")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
