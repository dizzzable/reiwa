/**
 * SubscriptionSelectCard
 * ──────────────────────
 * Unified "pick a subscription" tile used by every selection flow (renewal,
 * upgrade, add-ons). It now mirrors the DASHBOARD subscription card's visual —
 * the operator brand gradient, corner watermark, vignette and the same
 * identity / traffic / expiry / device layout — but **static** (no per-card
 * WebGL effect), so a list of selectable cards stays cheap to render while
 * reading as the same design as the dashboard.
 *
 * `control` chooses the selection affordance:
 *   - "check"  → square checkbox (multi-select, e.g. combined renewal)
 *   - "radio"  → round dot (single-select, e.g. upgrade / add-ons)
 *   - "none"   → no control (display only)
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Wifi, WifiOff } from "lucide-react";

import type { Subscription } from "@/types/api";
import { CardWatermark } from "@/components/ui/card-watermark";
import { useBranding } from "@/lib/branding-provider";
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
  const { branding } = useBranding();
  const sub = subscription;

  const isActive = sub.status === "ACTIVE" || sub.status === "LIMITED";
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
        "@container/card group relative w-full overflow-hidden rounded-card p-4 text-left text-white select-none",
        "shadow-xl shadow-black/40 transition-all active:scale-[0.98] disabled:opacity-50",
        selected ? "ring-2 ring-(--brand-primary)" : "ring-1 ring-white/10",
      )}
    >
      {/* Static foundation: dark base + operator brand gradient + vignette */}
      <div className="absolute inset-0 -z-30 bg-zinc-950" />
      <div
        className="absolute inset-0 -z-20"
        style={{ backgroundImage: branding.cardGradient, opacity: 0.9 }}
      />
      <div className="absolute inset-0 -z-10 bg-linear-to-b from-black/45 via-black/15 to-black/65" />

      {/* Brand watermark — operator glyph or custom image, faint */}
      <CardWatermark
        preset={branding.cardLogo}
        customUrl={branding.cardLogoUrl}
        className="pointer-events-none absolute -right-4 -bottom-6 h-28 w-28"
      />

      {/* Header: control + identity + trailing (price) */}
      <div className="relative flex items-center gap-3">
        {control !== "none" && (
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center border backdrop-blur-md",
              control === "radio" ? "rounded-full" : "rounded-md",
              selected
                ? "border-(--brand-primary) bg-(--brand-primary) text-(--brand-primary-fg)"
                : "border-white/40 bg-black/20",
            )}
          >
            {selected &&
              (control === "radio" ? (
                <span className="h-2.5 w-2.5 rounded-full bg-(--brand-primary-fg)" />
              ) : (
                <Check className="h-4 w-4" />
              ))}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isActive ? (
              <Wifi className="h-3.5 w-3.5 shrink-0 opacity-90" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 shrink-0 opacity-60" />
            )}
            <p className="truncate text-sm font-semibold tracking-wide drop-shadow">
              {subscriptionTitle(sub)}
            </p>
          </div>
          {subtitle && <p className="mt-0.5 truncate text-xs text-white/65">{subtitle}</p>}
        </div>
        {trailing && <div className="shrink-0 drop-shadow">{trailing}</div>}
      </div>

      {/* Traffic bar (or "unlimited") */}
      {progress !== null ? (
        <div className="relative mt-3 space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/35 backdrop-blur-sm">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress * 100}%`,
                backgroundColor: trafficColor ?? "rgba(255,255,255,0.85)",
              }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-white/60">
            <span>{t("subscriptionPicker.traffic")}</span>
            <span>
              {used} / {total} {t("subscriptionPicker.gb")}
            </span>
          </div>
        </div>
      ) : total === null ? (
        <div className="relative mt-3 flex items-center justify-between text-[11px] text-white/60">
          <span>{t("subscriptionPicker.traffic")}</span>
          <span>{t("subscriptionPicker.unlimited")}</span>
        </div>
      ) : null}

      {/* Footer: expiry + device limit */}
      <div className="relative mt-2 flex items-center justify-between text-[11px] text-white/55">
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
