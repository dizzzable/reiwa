/**
 * SubscriptionSelectCard
 * ──────────────────────
 * Unified, compact subscription tile used by every "pick a subscription" flow
 * (renewal, upgrade, add-ons). It mirrors the dashboard card's information —
 * identity, traffic bar, expiry, device limit — without the heavy WebGL
 * background, the action icons or the "details" affordance, so the three
 * wizards read as one design system.
 *
 * `control` chooses the selection affordance:
 *   - "check"  → square checkbox (multi-select, e.g. combined renewal)
 *   - "radio"  → round dot (single-select, e.g. upgrade / add-ons)
 *   - "none"   → no control (display only)
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

import type { Subscription } from "@/types/api";
import { cn, formatDate } from "@/lib/utils";

/** Subscription identity as shown on the dashboard card (profile first). */
function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}

export function SubscriptionSelectCard({
  subscription,
  selected,
  onSelect,
  control = "check",
  subtitle,
  trailing,
  disabled,
}: {
  subscription: Subscription;
  selected: boolean;
  onSelect: () => void;
  control?: "check" | "radio" | "none";
  /** Optional secondary line (e.g. plan · duration). */
  subtitle?: string;
  /** Optional trailing node, e.g. a price. */
  trailing?: React.ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const sub = subscription;

  const used = sub.trafficUsed ?? null;
  const total = sub.trafficLimit ?? null;
  const progress =
    total !== null && total > 0 && used !== null ? Math.min(used / total, 1) : null;

  // Green → amber → red as usage approaches the cap (mirrors the dashboard card).
  const trafficColor = useMemo(() => {
    if (progress === null) return null;
    const hue = Math.round(145 * (1 - progress));
    return `hsl(${hue} 85% 55%)`;
  }, [progress]);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "w-full glass-card p-4 text-left transition-all active:scale-[0.98] disabled:opacity-50",
        selected
          ? "border-(--brand-primary)/50 bg-(--brand-primary)/6"
          : "hover:border-(--brand-primary)/30",
      )}
    >
      {/* Header: control + identity + trailing (price) */}
      <div className="flex items-center gap-3">
        {control !== "none" && (
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center border",
              control === "radio" ? "rounded-full" : "rounded-md",
              selected
                ? "border-(--brand-primary) bg-(--brand-primary) text-black"
                : "border-white/20",
            )}
          >
            {selected &&
              (control === "radio" ? (
                <span className="h-2.5 w-2.5 rounded-full bg-black" />
              ) : (
                <Check className="h-4 w-4" />
              ))}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-medium text-white">
            {subscriptionTitle(sub)}
          </p>
          {subtitle && <p className="truncate text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>

      {/* Traffic bar (or "unlimited") */}
      {progress !== null ? (
        <div className="mt-3 space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress * 100}%`,
                backgroundColor: trafficColor ?? "rgba(255,255,255,0.85)",
              }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>{t("subscriptionPicker.traffic")}</span>
            <span>
              {used} / {total} {t("subscriptionPicker.gb")}
            </span>
          </div>
        </div>
      ) : total === null ? (
        <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
          <span>{t("subscriptionPicker.traffic")}</span>
          <span>{t("subscriptionPicker.unlimited")}</span>
        </div>
      ) : null}

      {/* Footer: expiry + device limit */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          {t("subscriptionPicker.expires")}: {formatDate(sub.expiresAt ?? sub.expireAt)}
        </span>
        {sub.deviceLimit !== null && (
          <span>{t("subscriptionPicker.devices", { count: sub.deviceLimit })}</span>
        )}
      </div>
    </button>
  );
}
