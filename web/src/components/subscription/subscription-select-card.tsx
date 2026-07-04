/**
 * SubscriptionSelectCard
 * ──────────────────────
 * Unified "pick a subscription" tile (renewal / upgrade / add-ons). It mirrors
 * the DASHBOARD subscription card — operator brand gradient, **live animated
 * effect**, corner watermark, vignette, identity / traffic / expiry / device —
 * but in a **more compact** size (it's a list row, not the hero card).
 *
 * Performance: the animated background uses the same `CardEffectLayer` as the
 * dashboard, which lazy-loads the effect (per-effect chunk) and pauses GPU work
 * for off-screen cards via IntersectionObserver — so a list of cards only runs
 * the effect for what's actually visible.
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
import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { CardWatermark } from "@/components/ui/card-watermark";
import { useBranding } from "@/lib/branding-provider";
import { brandAuroraStops, cn, formatDate } from "@/lib/utils";

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
  index,
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
  /** Position in the list — selects the matching per-position card effect slot. */
  index?: number;
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

  // Resolve the live animated background exactly like the dashboard card:
  // per-position slot → else the global operator effect; aurora is auto-tinted
  // to the brand colour when no explicit colorStops are pinned.
  const auroraStops = useMemo(() => brandAuroraStops(branding.primary), [branding.primary]);
  const slot = index !== undefined ? branding.cardEffectsByIndex?.[index] : undefined;
  const effect = slot?.cardEffect ?? branding.cardEffect;
  const slotProps = slot?.cardEffectProps;
  const effectProps = useMemo<Record<string, unknown>>(() => {
    const base = slotProps ?? branding.cardEffectProps ?? {};
    if (effect === "aurora" && base["colorStops"] === undefined) {
      return { colorStops: auroraStops, amplitude: 1.1, blend: 0.55, speed: 0.8, ...base };
    }
    return base;
  }, [effect, slotProps, branding.cardEffectProps, auroraStops]);
  const effectOpacity = slot?.cardEffectOpacity ?? branding.cardEffectOpacity ?? 1;
  const cardGradient =
    (slot?.cardGradient ?? "").trim().length > 0
      ? (slot!.cardGradient as string)
      : branding.cardGradient;

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "@container/card group relative w-full overflow-hidden rounded-card p-3.5 text-left text-white select-none",
        "shadow-lg shadow-black/30 transition-all active:scale-[0.98] disabled:opacity-50",
        selected ? "ring-2 ring-(--brand-primary)" : "ring-1 ring-white/10",
      )}
    >
      {/* Static foundation: dark base + operator brand gradient */}
      <div className="absolute inset-0 -z-30 bg-zinc-950" />
      <div
        className="absolute inset-0 -z-25"
        style={{ backgroundImage: cardGradient, opacity: 0.9 }}
      />
      {/* Live animated effect (lazy, pauses off-screen). NONE = gradient only. */}
      {effect !== "NONE" && (
        <CardEffectLayer
          effect={effect}
          props={effectProps}
          opacity={effectOpacity}
          className="absolute inset-0 -z-20"
        />
      )}
      <div className="absolute inset-0 -z-10 bg-linear-to-b from-black/45 via-black/15 to-black/65" />

      {/* Brand watermark — operator glyph or custom image, faint */}
      <CardWatermark
        preset={branding.cardLogo}
        customUrl={branding.cardLogoUrl}
        className="pointer-events-none absolute -right-3 -bottom-5 h-24 w-24"
      />

      {/* Header: control + identity + trailing (price) */}
      <div className="relative flex items-center gap-2.5">
        {control !== "none" && (
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center border backdrop-blur-md",
              control === "radio" ? "rounded-full" : "rounded-md",
              selected
                ? "border-(--brand-primary) bg-(--brand-primary) text-(--brand-primary-fg)"
                : "border-white/40 bg-black/20",
            )}
          >
            {selected &&
              (control === "radio" ? (
                <span className="h-2 w-2 rounded-full bg-(--brand-primary-fg)" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              ))}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isActive ? (
              <Wifi className="h-3 w-3 shrink-0 opacity-90" />
            ) : (
              <WifiOff className="h-3 w-3 shrink-0 opacity-60" />
            )}
            <p className="truncate text-[13px] font-semibold tracking-wide drop-shadow">
              {subscriptionTitle(sub)}
            </p>
          </div>
          {subtitle && <p className="mt-0.5 truncate text-[11px] text-white/65">{subtitle}</p>}
        </div>
        {trailing && <div className="shrink-0 drop-shadow">{trailing}</div>}
      </div>

      {/* Traffic bar (or "unlimited") */}
      {progress !== null ? (
        <div className="relative mt-2.5 space-y-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-black/35 backdrop-blur-sm">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress * 100}%`,
                backgroundColor: trafficColor ?? "rgba(255,255,255,0.85)",
              }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-white/60">
            <span>{t("subscriptionPicker.traffic")}</span>
            <span>
              {used} / {total} {t("subscriptionPicker.gb")}
            </span>
          </div>
        </div>
      ) : total === null ? (
        <div className="relative mt-2.5 flex items-center justify-between text-[10px] text-white/60">
          <span>{t("subscriptionPicker.traffic")}</span>
          <span>{t("subscriptionPicker.unlimited")}</span>
        </div>
      ) : null}

      {/* Footer: expiry + device limit */}
      <div className="relative mt-1.5 flex items-center justify-between text-[10px] text-white/55">
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
