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
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

import type { Plan } from "@/types/api";
import { useBranding } from "@/lib/branding-provider";
import { cn } from "@/lib/utils";
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
): { amount: number; currency: string; days: number } | null {
  const gateway = plan.durations.flatMap((d) =>
    d.prices.map((p) => ({ currency: p.currency, amount: Number(p.price), days: d.days })),
  );
  const display = (plan.displayPrices ?? []).map((p) => ({
    currency: p.currency,
    amount: Number(p.price),
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
  return { amount: min.amount, currency: min.currency, days: minDays };
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
  const priceColor = readablePriceColor(accent);

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "@container/card group relative flex min-h-[172px] w-full flex-col justify-between gap-3",
        "overflow-hidden rounded-card p-5 text-left text-white select-none",
        "shadow-xl shadow-black/40 transition-transform duration-150 active:scale-[0.98]",
        selected ? "ring-2 ring-(--brand-primary)" : "ring-1 ring-white/10",
      )}
    >
      {/* Static foundation: dark base + per-plan gradient */}
      <div className="absolute inset-0 -z-30 bg-zinc-950" />
      <div className="absolute inset-0 -z-25" style={{ backgroundImage: visual.gradient }} />
      {/* Texture overlay: uploaded image (cover) wins over a preset pattern. */}
      {visual.textureUrl ? (
        <div
          className="absolute inset-0 -z-20 bg-cover bg-center opacity-25"
          style={{ backgroundImage: `url(${visual.textureUrl})` }}
        />
      ) : visual.textureImage ? (
        <div
          className="absolute inset-0 -z-20"
          style={{ backgroundImage: visual.textureImage, backgroundSize: visual.textureSize ?? undefined }}
        />
      ) : null}
      <div className="absolute inset-0 -z-10 bg-linear-to-br from-black/35 via-black/10 to-black/55" />

      <CardWatermark
        preset={branding.cardLogo}
        customUrl={branding.cardLogoUrl}
        className="absolute -right-5 -bottom-7 h-32 w-32 @sm:h-36 @sm:w-36"
      />

      {/* Selection check badge */}
      {selected && (
        <span className="absolute top-3 right-3 flex h-6 w-6 items-center justify-center rounded-full bg-(--brand-primary) text-(--brand-primary-fg) shadow-md">
          <Check className="h-4 w-4" />
        </span>
      )}

      {/* Top: clean plan icon (no chip) + name + traffic/devices + description */}
      <div className="relative flex items-start gap-3.5">
        <div className="shrink-0 leading-none drop-shadow" style={{ color: accent }}>
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
              <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase backdrop-blur-md">
                {t("plans.trialBadge")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-medium text-white/85">
            {plan.trafficLimit ? `${plan.trafficLimit} GB` : t("plans.unlimited")}
            {plan.deviceLimit ? ` · ${t("plans.devicesSuffix", { count: plan.deviceLimit })}` : ""}
          </p>
          {plan.description && (
            <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-white/70">
              {plan.description}
            </p>
          )}
        </div>
      </div>

      {/* Bottom: duration options (left) + lowest price (right) */}
      <div className="relative flex items-end justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] tracking-wider text-white/55 uppercase">
          {t("plans.durationOptions", { count: plan.durations.length })}
        </p>
        {price && (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span
              className="rounded-full bg-black/30 px-2.5 py-0.5 text-[15px] font-bold ring-1 ring-white/10 backdrop-blur-sm drop-shadow"
              style={{ color: priceColor }}
            >
              {t("plans.from")} {CURRENCY_SYMBOLS[price.currency] ?? ""}
              {price.amount.toFixed(2)}
            </span>
            <span className="text-[11px] text-white/60">
              {t("plans.fromDuration", { count: price.days })}
            </span>
          </div>
        )}
      </div>
    </motion.button>
  );
}
