/**
 * TariffCard
 * ──────────
 * The subscription-card-style tariff tile used on the `/plans` catalog AND in
 * the renewal "choose a tariff" step, so both read identically. Static (no
 * WebGL): per-plan gradient + texture + accent + clean icon + name + traffic +
 * description + "от {price}". Pass `selected` to render a selection ring (used
 * by the renewal picker).
 */
import { motion } from "motion/react";
import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

import type { Plan } from "@/types/api";
import { useBranding } from "@/lib/branding-provider";
import { brandAuroraStops, cn } from "@/lib/utils";
import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { CardWatermark } from "@/components/ui/card-watermark";
import { CustomIconView } from "@/components/ui/custom-icon-view";
import { EmojiText } from "@/components/ui/emoji-text";
import { customIconId, isEmojiIcon, resolvePlanIcon } from "./plan-icons";
import { resolvePlanCardStyle, readablePriceColor } from "./plan-card-visual";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
};

/**
 * Lowest price for a plan in the preferred display currency (gateway prices →
 * else operator `displayPrices`). Pure display selection, no conversion.
 */
export function getLowestPlanPrice(
  plan: Plan,
  preferredCurrency: string,
): {
  amount: number;
  currency: string;
  days: number;
  originalAmount: number;
  discountPercent: number;
  discountSource: string;
} | null {
  const gateway = plan.durations.flatMap((d) =>
    d.prices.map((p) => ({
      currency: p.currency,
      amount: Number(p.price),
      originalAmount: p.originalPrice !== undefined ? Number(p.originalPrice) : Number(p.price),
      discountPercent: p.discountPercent ?? 0,
      discountSource: p.discountSource ?? "NONE",
      days: d.days,
    })),
  );
  const display = (plan.displayPrices ?? []).map((p) => ({
    currency: p.currency,
    amount: Number(p.price),
    // Operator display prices carry no per-user discount — show them as-is.
    originalAmount: Number(p.price),
    discountPercent: 0,
    discountSource: "NONE",
    days: p.days,
  }));
  const all = gateway.length ? gateway : display;
  if (!all.length) return null;
  const preferred = all.filter((p) => p.currency === preferredCurrency);
  const usd = all.filter((p) => p.currency === "USD");
  const rub = all.filter((p) => p.currency === "RUB");
  const list = preferred.length ? preferred : usd.length ? usd : rub.length ? rub : all;
  const minDays = Math.min(...all.map((p) => p.days));
  const min = list.reduce((m, p) => (p.amount < m.amount ? p : m), list[0]!);
  return {
    amount: min.amount,
    currency: min.currency,
    days: minDays,
    originalAmount: min.originalAmount,
    discountPercent: min.discountPercent,
    discountSource: min.discountSource,
  };
}

interface TariffCardProps {
  readonly plan: Plan;
  readonly onClick: () => void;
  /** Render a selection ring + check badge (renewal tariff picker). */
  readonly selected?: boolean;
  /** Entrance-animation stagger index. */
  readonly index?: number;
}

export function TariffCard({ plan, onClick, selected, index = 0 }: TariffCardProps) {
  const { t } = useTranslation();
  const { branding, defaultCurrency, customIcons } = useBranding();

  const price = getLowestPlanPrice(plan, defaultCurrency);
  const customId = customIconId(plan.icon);
  const custom = customId ? customIcons.find((c) => c.id === customId) : undefined;
  const Icon = resolvePlanIcon(plan.icon, plan.type);
  const visual = resolvePlanCardStyle(String(plan.id), branding);
  const accent = visual.accent ?? branding.primary;
  const { contrast } = visual;
  const readableAccent = readablePriceColor(
    accent,
    contrast.effectiveBackground,
    contrast.foreground,
  );
  const cardStyle = {
    "--card-foreground": contrast.foreground,
    "--card-foreground-rgb": contrast.foregroundRgb,
    "--card-veil-rgb": contrast.veilRgb,
    boxShadow:
      contrast.foregroundTone === "dark"
        ? "0 20px 36px -12px rgb(0 0 0 / 0.20)"
        : "0 20px 36px -12px rgb(0 0 0 / 0.38)",
  } as CSSProperties;

  // Per-plan animated effect (opt-in). Tariff cards do NOT inherit the
  // subscription card's global effect anymore — an unset per-plan effect keeps
  // the card static. `aurora` is auto-tinted to the brand colour when no
  // explicit colorStops are pinned. Rendered off-screen-paused via the
  // CardEffectLayer IntersectionObserver.
  const auroraStops = useMemo(() => brandAuroraStops(branding.primary), [branding.primary]);
  const effect = visual.effect;
  const effectProps = useMemo<Record<string, unknown>>(() => {
    const base = visual.effectProps ?? {};
    if (effect === "aurora" && base["colorStops"] === undefined) {
      return { colorStops: auroraStops, amplitude: 1.1, blend: 0.55, speed: 0.8, ...base };
    }
    return base;
  }, [effect, visual.effectProps, auroraStops]);
  const effectOpacity = visual.effectOpacity ?? 1;
  // A per-plan uploaded image is the deliberate art for that card, so it WINS
  // over the animated shader — we don't render the effect when a custom image
  // is set (the two would fight / wash each other out). Preset pattern grains
  // (textureImage) are subtle overlays and safely sit on top of the effect.
  const showEffect = effect !== "NONE" && !visual.textureUrl;

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      onClick={onClick}
      aria-pressed={selected}
      style={cardStyle}
      className={cn(
        "@container/card group relative flex min-h-[172px] w-full flex-col justify-between gap-3",
        "overflow-hidden rounded-card p-5 text-left text-[color:var(--card-foreground)] select-none",
        "transition-transform duration-150 active:scale-[0.98]",
        selected
          ? "ring-2 ring-(--brand-primary)"
          : "ring-1 ring-[rgb(var(--card-foreground-rgb)/0.12)]",
      )}
    >
      {/* Static foundation: semantic fallback canvas + per-plan gradient.
          All background layers use z-0 (NOT negative z): iOS Safari won't paint
          negative-z children inside this @container + overflow-hidden + rounded
          motion.button, so the background vanishes on iPhone. DOM order preserves
          the visual stack on every platform. (transform-gpu can't help here —
          Framer Motion owns this element's inline transform.) */}
      <div
        className="absolute inset-0 z-0"
        style={{ backgroundColor: contrast.foundation }}
      />
      <div className="absolute inset-0 z-0" style={{ backgroundImage: visual.gradient }} />
      {/* Animated effect layer (per-plan, opt-in; NONE = gradient only).
          Suppressed when the plan has a custom uploaded image so the two never
          clash. DOM order keeps it above the gradient, below the per-plan
          texture + vignette so those keep text legible. */}
      {showEffect && (
        <CardEffectLayer
          effect={effect}
          props={effectProps}
          opacity={effectOpacity}
          className="absolute inset-0 z-0"
        />
      )}
      {/* Texture overlay: uploaded image (cover) wins over a preset pattern. */}
      {visual.textureUrl ? (
        <div
          className="absolute inset-0 z-0 bg-cover bg-center opacity-25"
          style={{ backgroundImage: `url(${visual.textureUrl})` }}
        />
      ) : visual.textureImage ? (
        <div
          className="absolute inset-0 z-0"
          style={{ backgroundImage: visual.textureImage, backgroundSize: visual.textureSize ?? undefined }}
        />
      ) : null}
      <div
        className="absolute inset-0 z-0"
        style={{ background: contrast.overlayBackground }}
      />

      <CardWatermark
        preset={branding.cardLogo}
        customUrl={branding.cardLogoUrl}
        className="absolute -right-5 -bottom-7 h-32 w-32 text-[color:var(--card-foreground)] opacity-10 @sm:h-36 @sm:w-36"
      />

      {/* Selection check badge */}
      {selected && (
        <span className="absolute top-3 right-3 flex h-6 w-6 items-center justify-center rounded-full bg-(--brand-primary) text-(--brand-primary-fg) shadow-md">
          <Check className="h-4 w-4" />
        </span>
      )}

      {/* Top: clean plan icon (no chip) + name + traffic/devices + description */}
      <div className="relative flex items-start gap-3.5">
        <div className="shrink-0 leading-none drop-shadow" style={{ color: readableAccent }}>
          {isEmojiIcon(plan.icon) ? (
            <EmojiText text={plan.icon} className="text-3xl leading-none" />
          ) : custom ? (
            <CustomIconView url={custom.url} color={custom.color} className="h-9 w-9" />
          ) : (
            <Icon className="h-8 w-8" strokeWidth={1.75} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[17px] font-semibold tracking-wide drop-shadow">{plan.name}</p>
            {plan.isTrial && (
              <span className="shrink-0 rounded-full border border-[rgb(var(--card-foreground-rgb)/0.12)] bg-[rgb(var(--card-veil-rgb)/0.30)] px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase backdrop-blur-md">
                {t("plans.trialBadge")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-medium opacity-[0.85]">
            {plan.trafficLimit ? `${plan.trafficLimit} GB` : t("plans.unlimited")}
            {plan.deviceLimit ? ` · ${t("plans.devicesSuffix", { count: plan.deviceLimit })}` : ""}
          </p>
          {plan.description && (
            <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug opacity-[0.70]">
              {plan.description}
            </p>
          )}
        </div>
      </div>

      {/* Bottom: duration options (left) + lowest price (right) */}
      <div className="relative flex items-end justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] tracking-wider uppercase opacity-[0.55]">
          {t("plans.durationOptions", { count: plan.durations.length })}
        </p>
        {price && (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            {price.discountPercent > 0 && price.discountSource !== "NONE" && (
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1",
                    contrast.foregroundTone === "dark"
                      ? "bg-emerald-500/15 text-emerald-800 ring-emerald-700/30"
                      : "bg-emerald-500/20 text-emerald-300 ring-emerald-400/30",
                  )}
                >
                  −{price.discountPercent}%
                </span>
                <span className="text-[11px] line-through opacity-[0.45]">
                  {CURRENCY_SYMBOLS[price.currency] ?? ""}
                  {price.originalAmount.toFixed(2)}
                </span>
              </div>
            )}
            <span
              className="rounded-full border px-2.5 py-0.5 text-[15px] font-bold backdrop-blur-sm drop-shadow"
              style={{
                color: readableAccent,
                backgroundColor: contrast.supportBackground,
                borderColor: `rgb(${contrast.foregroundRgb} / 0.12)`,
              }}
            >
              {t("plans.from")} {CURRENCY_SYMBOLS[price.currency] ?? ""}
              {price.amount.toFixed(2)}
            </span>
            <span className="text-[11px] opacity-[0.60]">
              {t("plans.fromDuration", { count: price.days })}
            </span>
          </div>
        )}
      </div>
    </motion.button>
  );
}
