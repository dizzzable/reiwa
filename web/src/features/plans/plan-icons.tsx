/**
 * Plan icon registry (reiwa SPA).
 * ───────────────────────────────
 * Maps an operator-chosen icon key (stored on `Plan.icon`) to a Lucide glyph.
 * When a plan has no explicit icon, we fall back to a sensible default derived
 * from the plan `type`. Kept in lockstep with the admin plan-form picker.
 */

import {
  Zap,
  Shield,
  Infinity as InfinityIcon,
  Crown,
  Gem,
  Rocket,
  Star,
  Flame,
  Bolt,
  Globe,
  Wifi,
  Gauge,
  Sparkles,
  Award,
  type LucideIcon,
} from "lucide-react";

/** Selectable icon keys shown in the admin plan form. */
export const PLAN_ICON_KEYS = [
  "zap",
  "shield",
  "infinity",
  "crown",
  "gem",
  "rocket",
  "star",
  "flame",
  "bolt",
  "globe",
  "wifi",
  "gauge",
  "sparkles",
  "award",
] as const;

export type PlanIconKey = (typeof PLAN_ICON_KEYS)[number];

const ICON_MAP: Record<PlanIconKey, LucideIcon> = {
  zap: Zap,
  shield: Shield,
  infinity: InfinityIcon,
  crown: Crown,
  gem: Gem,
  rocket: Rocket,
  star: Star,
  flame: Flame,
  bolt: Bolt,
  globe: Globe,
  wifi: Wifi,
  gauge: Gauge,
  sparkles: Sparkles,
  award: Award,
};

const TYPE_FALLBACK: Record<string, LucideIcon> = {
  TRAFFIC: Zap,
  DEVICES: Shield,
  UNLIMITED: InfinityIcon,
  BOTH: Shield,
};

/**
 * Resolves the icon component for a plan: explicit `icon` key wins, otherwise
 * a type-derived default, otherwise a generic shield.
 */
export function resolvePlanIcon(
  icon: string | null | undefined,
  type: string | null | undefined,
): LucideIcon {
  if (icon && icon in ICON_MAP) {
    return ICON_MAP[icon as PlanIconKey];
  }
  if (type && type in TYPE_FALLBACK) {
    return TYPE_FALLBACK[type];
  }
  return Shield;
}
