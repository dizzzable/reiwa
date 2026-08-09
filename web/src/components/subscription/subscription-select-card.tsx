/**
 * SubscriptionSelectCard
 * ──────────────────────
 * Unified "pick a subscription" tile (renewal / upgrade / add-ons). It mirrors
 * the DASHBOARD subscription card — operator brand gradient, **live animated
 * effect**, corner watermark, vignette, identity / traffic / expiry / device —
 * but in a **more compact** size (it's a list row, not the hero card).
 *
 * Performance: the animated background uses the same `CardEffectLayer` as the
 * dashboard, which lazy-loads the effect (per-effect chunk) and draws nothing
 * for off-screen cards — so a list only runs the effect for what's visible. On
 * top of that, a WebGL effect must win a slot from the shared context budget
 * (`@/lib/card-effect-budget`): "visible" is not a ceiling, and these tiles are
 * short enough that a tall viewport puts more of them on screen than WebKit
 * will give the process contexts for.
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
import { CustomIconView } from "@/components/ui/custom-icon-view";
import { EmojiText } from "@/components/ui/emoji-text";
import { customIconId, isEmojiIcon, resolveBuiltInIcon } from "@/features/plans/plan-icons";
import { useBranding } from "@/lib/branding-provider";
import { useCardEffectSlot } from "@/lib/card-effect-budget";
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
  const { branding, customIcons } = useBranding();
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

  // Plan's own icon (frozen in the subscription snapshot), same 3-way resolution
  // and same fallback as the dashboard card — this tile advertises itself as a
  // mirror of it, so the picker must not show Wi-Fi where the dashboard shows
  // the plan glyph. No icon on the plan → the connectivity status glyph.
  const planIcon = sub.plan?.icon ?? null;
  const planCustomId = customIconId(planIcon);
  const planCustom = planCustomId
    ? customIcons.find((c) => c.id === planCustomId)
    : undefined;
  const PlanBuiltInIcon = resolveBuiltInIcon(planIcon);
  const nameIcon = isEmojiIcon(planIcon) ? (
    <EmojiText
      text={planIcon}
      className={cn("shrink-0 text-xs leading-none", !isActive && "opacity-60")}
    />
  ) : planCustom ? (
    <CustomIconView
      url={planCustom.url}
      color={planCustom.color}
      className={cn("h-3 w-3 shrink-0", !isActive && "opacity-60")}
    />
  ) : PlanBuiltInIcon ? (
    <PlanBuiltInIcon className={cn("h-3 w-3 shrink-0", !isActive && "opacity-60")} />
  ) : isActive ? (
    <Wifi className="h-3 w-3 shrink-0 opacity-90" />
  ) : (
    <WifiOff className="h-3 w-3 shrink-0 opacity-60" />
  );

  // Resolve the live animated background exactly like the dashboard card:
  // per-position slot → else the global operator effect; aurora is auto-tinted
  // to the brand colour when no explicit colorStops are pinned.
  const auroraStops = useMemo(() => brandAuroraStops(branding.primary), [branding.primary]);
  const slot = index !== undefined ? branding.cardEffectsByIndex?.[index] : undefined;
  const slotOverridesEffect = slot?.mode === "override";
  const effect = slotOverridesEffect ? slot?.cardEffect ?? branding.cardEffect : branding.cardEffect;
  const slotProps = slotOverridesEffect ? slot?.cardEffectProps : undefined;
  const effectProps = useMemo<Record<string, unknown>>(() => {
    const base = slotProps ?? branding.cardEffectProps ?? {};
    if (effect === "aurora" && base["colorStops"] === undefined) {
      return { colorStops: auroraStops, amplitude: 1.1, blend: 0.55, speed: 0.8, ...base };
    }
    return base;
  }, [effect, slotProps, branding.cardEffectProps, auroraStops]);
  const effectOpacity = slotOverridesEffect
    ? slot?.cardEffectOpacity ?? branding.cardEffectOpacity ?? 1
    : branding.cardEffectOpacity ?? 1;
  const cardGradient =
    (slot?.cardGradient ?? "").trim().length > 0
      ? (slot!.cardGradient as string)
      : branding.cardGradient;

  // The worst of the two call sites for context pressure: these tiles are
  // ~112 px tall and they ALL draw the operator's one global `cardEffect`
  // (default `aurora`, WebGL1), so a phone puts seven or eight on screen and a
  // tablet twelve — each its own context, against WebKit's pool of 16 shared
  // with the app background. The slot caps how many may be live at once; the
  // rest keep the operator's gradient. See `card-effect-budget`.
  const effectSlot = useCardEffectSlot(effect);

  return (
    <button
      ref={effectSlot.ref}
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "@container/card group relative isolate w-full overflow-hidden rounded-card p-3.5 text-left text-white select-none [contain:paint]",
        "shadow-lg shadow-black/30 transition-all active:scale-[0.98] disabled:opacity-50",
        selected ? "ring-2 ring-(--brand-primary)" : "ring-1 ring-white/10",
      )}
    >
      {/* Static foundation: dark base + operator brand gradient */}
      <div className="absolute inset-0 z-0 bg-zinc-950" />
      <div
        className="absolute inset-0 z-0"
        style={{ backgroundImage: cardGradient, opacity: 0.9 }}
      />
      {/* Live animated effect (lazy, pauses off-screen). NONE = gradient only.
          z-0 (not negative z): iOS Safari won't paint negative-z children inside
          this @container + overflow-hidden + rounded box. */}
      {effect !== "NONE" && (
        <CardEffectLayer
          effect={effect}
          props={effectProps}
          opacity={effectOpacity}
          active={effectSlot.active}
          className="absolute inset-0 z-0"
        />
      )}
      <div className="absolute inset-0 z-0 bg-linear-to-b from-black/45 via-black/15 to-black/65" />

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
            {nameIcon}
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
