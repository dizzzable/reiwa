/**
 * SubscriptionCard
 * ────────────────
 * Bank-card-style visual for a single subscription. The background is a live
 * React Bits **Aurora** WebGL shader tinted to the operator's brand colour, so
 * every card flows with the active branding. The Reiwa mark sits as a faint
 * watermark; plan name + status ride on top.
 *
 * Layout:
 *   - Plan name + connectivity icon (top-left)
 *   - Status pill (top-right)
 *   - Profile id / remnawave id (centre, monospace — like a card number)
 *   - Traffic progress bar
 *   - Expiry (bottom-left) + first device (bottom-right)
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Wifi, WifiOff } from "lucide-react";

import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { CardWatermark } from "@/components/ui/card-watermark";
import { useBranding } from "@/lib/branding-provider";
import { brandAuroraStops, cn, formatDate } from "@/lib/utils";
import type { Subscription } from "@/types/api";

interface SubscriptionCardProps {
  subscription: Subscription;
  /** First device name to show on the card face. */
  firstDevice?: string | null;
}

export function SubscriptionCard({ subscription, firstDevice }: SubscriptionCardProps) {
  const { t } = useTranslation();
  const { branding } = useBranding();
  const sub = subscription;

  const isActive = sub.status === "ACTIVE" || sub.status === "LIMITED";
  const statusLabel = isActive
    ? t("card.activeStatus")
    : sub.status === "EXPIRED"
      ? t("card.expiredStatus")
      : t("card.pendingStatus");

  const auroraStops = useMemo(
    () => brandAuroraStops(branding.primary),
    [branding.primary],
  );

  // Traffic progress (0–1). When unlimited, show full bar.
  const trafficUsedGb = sub.trafficUsed ?? null;
  const trafficTotalGb = sub.trafficLimit ?? null;
  const trafficProgress =
    trafficTotalGb !== null && trafficTotalGb > 0 && trafficUsedGb !== null
      ? Math.min(trafficUsedGb / trafficTotalGb, 1)
      : null;

  // Color shifts smoothly green → amber → red as usage approaches the limit
  // (mirrors the WEB Reiwa preview). Hue runs 145° (green) → 0° (red) as the
  // bar fills, so the closer to the cap, the "hotter" the bar reads.
  const trafficColor = useMemo(() => {
    if (trafficProgress === null) return null;
    const hue = Math.round(145 * (1 - trafficProgress));
    return `hsl(${hue} 85% 55%)`;
  }, [trafficProgress]);

  // Resolve the card background effect. A per-subscription override wins over
  // the global branding choice, letting multi-sub users get distinct cards.
  // `aurora` (the default) is auto-tinted to the brand colour when the
  // operator hasn't pinned explicit colorStops, preserving the stock look.
  const effect = sub.cardEffect ?? branding.cardEffect;
  const effectProps = useMemo<Record<string, unknown>>(() => {
    const base = sub.cardEffectProps ?? branding.cardEffectProps ?? {};
    if (effect === "aurora" && base["colorStops"] === undefined) {
      return { colorStops: auroraStops, amplitude: 1.1, blend: 0.55, speed: 0.8, ...base };
    }
    return base;
  }, [effect, sub.cardEffectProps, branding.cardEffectProps, auroraStops]);
  const effectOpacity = sub.cardEffectOpacity ?? branding.cardEffectOpacity ?? 1;

  return (
    <div
      className={cn(
        // `@container/card` makes the card a container-query context so its
        // contents scale to the CARD's width, not the viewport — it looks
        // right both in a 320px phone column and a 440px desktop column.
        "@container/card relative flex h-[190px] w-full flex-col justify-between overflow-hidden rounded-card p-4 text-white select-none",
        "@sm:h-[210px] @sm:p-5",
        "shadow-2xl shadow-black/40 ring-1 ring-white/10",
      )}
    >
      {/* Dark base + operator gradient as the static foundation / fallback */}
      <div className="absolute inset-0 -z-30 bg-zinc-950" />
      <div
        className="absolute inset-0 -z-25"
        style={{ backgroundImage: branding.cardGradient }}
      />
      {/* Animated effect layer (operator-configurable; NONE = gradient only) */}
      {effect !== "NONE" && (
        <CardEffectLayer
          effect={effect}
          props={effectProps}
          opacity={effectOpacity}
          className="absolute inset-0 -z-20"
        />
      )}
      {/* Depth: top/bottom vignette so text stays legible over any effect */}
      <div className="absolute inset-0 -z-10 bg-linear-to-b from-black/55 via-black/15 to-black/65" />

      {/* Brand watermark — operator-configurable glyph or custom image */}
      <CardWatermark
        preset={branding.cardLogo}
        customUrl={branding.cardLogoUrl}
        className="absolute -right-6 -bottom-8 h-40 w-40 @sm:h-44 @sm:w-44"
      />

      {/* Top row: plan name + status */}
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isActive ? (
            <Wifi className="h-4 w-4 shrink-0 opacity-90" />
          ) : (
            <WifiOff className="h-4 w-4 shrink-0 opacity-60" />
          )}
          <span className="truncate text-[13px] font-semibold tracking-wide opacity-95 @sm:text-sm">
            {sub.plan?.name ?? "Subscription"}
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wider uppercase backdrop-blur-md",
            isActive
              ? "bg-white/25 text-white shadow-sm"
              : "bg-black/40 text-white/70",
          )}
        >
          {statusLabel}
        </span>
      </div>

      {/* Animation picker removed — per-card animation is configured by the
          operator in the admin panel (user-detail subscription card), not by
          the end user. The per-sub override still flows in via `sub.cardEffect`
          above. */}

      {/* Center: profile name (like card number) */}
      <div className="relative flex min-w-0 flex-1 items-center">
        <p className="w-full truncate font-mono text-[13px] tracking-[0.12em] text-white/90 drop-shadow @sm:text-[15px]">
          {sub.profileName || sub.userRemnaId || sub.id}
        </p>
      </div>

      {/* Bottom row: traffic + expiry + first device */}
      <div className="relative space-y-2.5">
        {trafficProgress !== null ? (
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/35 backdrop-blur-sm">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${trafficProgress * 100}%`,
                  backgroundColor: trafficColor ?? "rgba(255,255,255,0.85)",
                  boxShadow:
                    trafficProgress > 0.85 && trafficColor
                      ? `0 0 10px ${trafficColor}`
                      : "none",
                }}
              />
            </div>
            <p className="text-[10px] tracking-wider uppercase opacity-70">
              {t("card.trafficUsed")}: {trafficUsedGb} / {trafficTotalGb} GB
            </p>
          </div>
        ) : trafficTotalGb === null ? (
          <p className="text-[10px] tracking-wider uppercase opacity-70">
            {t("card.trafficUnlimited")}
          </p>
        ) : null}

        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] tracking-wider uppercase opacity-60">
              {t("card.expiresOn")}
            </p>
            <p className="truncate text-[13px] font-semibold @sm:text-sm">{formatDate(sub.expiresAt ?? sub.expireAt)}</p>
          </div>
          <div className="min-w-0 text-right">
            <p className="text-[10px] tracking-wider uppercase opacity-60">
              {t("card.firstDevice")}
            </p>
            <p className="truncate text-[13px] font-medium @sm:text-sm">
              {firstDevice ?? t("card.noDevicesYet")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
