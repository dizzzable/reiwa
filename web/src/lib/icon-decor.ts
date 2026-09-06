/**
 * Operator decoration for the dashboard header icons.
 *
 * The operator picks, per icon, a glyph / an attention effect / an accent
 * colour in the panel; this resolves what they picked into the three things a
 * call site needs. Nothing here is a subscriber setting — appearance belongs
 * to the operator's brand, which is why the cabinet only ever reads it.
 *
 * An icon with no entry resolves to "everything as shipped", so a cabinet
 * whose operator never opened that block renders byte-for-byte what it did
 * before this file existed.
 */

import type { CSSProperties } from "react";
import {
  Bell,
  Crown,
  Flame,
  Gem,
  Gift,
  Heart,
  Rocket,
  ShoppingCart,
  Sparkles,
  Star,
  Target,
  TicketPercent,
  Trophy,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { useBranding } from "@/lib/branding-provider";
import { resolveIconEffect } from "@/types/branding";

/**
 * Glyphs an operator can swap in, keyed by the panel's vocabulary.
 *
 * `default` is deliberately absent rather than mapped: the caller supplies
 * what it ships, and a missing key here means the same thing as `default` —
 * which is what makes a glyph name from a NEWER panel harmless.
 */
const GLYPHS: Readonly<Record<string, LucideIcon>> = {
  sparkles: Sparkles,
  gift: Gift,
  star: Star,
  trophy: Trophy,
  crown: Crown,
  flame: Flame,
  zap: Zap,
  rocket: Rocket,
  heart: Heart,
  gem: Gem,
  target: Target,
  bell: Bell,
  cart: ShoppingCart,
  ticket: TicketPercent,
};

const EFFECT_CLASS: Readonly<Record<string, string>> = {
  pulse: "icon-effect-pulse",
  shake: "icon-effect-shake",
  glow: "icon-effect-glow",
};

export interface ResolvedIconDecor {
  /** The glyph to draw, or `null` to keep the one the call site ships. */
  readonly Glyph: LucideIcon | null;
  /** Class for the wrapper, or `""` for no effect. */
  readonly effectClass: string;
  /**
   * Goes on the WRAPPER: carries `--icon-effect-color`, which the glow's
   * pseudo-element reads. Separate from `glyphStyle` because the button
   * between them sets its own `color` class, and a class on the child beats
   * an inline style on the parent — the tint would silently do nothing.
   */
  readonly wrapperStyle: CSSProperties | undefined;
  /** Goes on the GLYPH itself, where an inline colour actually wins. */
  readonly glyphStyle: CSSProperties | undefined;
}

const NOTHING: ResolvedIconDecor = {
  Glyph: null,
  effectClass: "",
  wrapperStyle: undefined,
  glyphStyle: undefined,
};

/**
 * Resolve one dashboard icon's decoration.
 *
 * Every unknown value degrades instead of throwing: the panel ships ahead of
 * this image, so a glyph or effect named by a newer panel must leave the icon
 * looking shipped rather than blank.
 */
export function useIconDecor(key: string): ResolvedIconDecor {
  const { branding } = useBranding();
  const decor = branding.iconDecor?.[key];
  if (decor === undefined) return NOTHING;

  // `Object.hasOwn`, not `??`: a plain object literal answers `constructor`,
  // `toString` and friends from its prototype, and `??` keeps whatever comes
  // back. `constructor` is the one such name that also passes the panel's slug
  // validator, so it can be stored and served to every cabinet — and React
  // given `Object` as a component throws, taking the whole dashboard header
  // down instead of degrading to the shipped icon. Every other unknown glyph
  // already fell back; this one did not.
  const Glyph =
    decor.glyph !== undefined && Object.hasOwn(GLYPHS, decor.glyph)
      ? (GLYPHS[decor.glyph] ?? null)
      : null;
  const effectClass = EFFECT_CLASS[resolveIconEffect(decor.effect)] ?? "";
  // One picker, two jobs: `--icon-effect-color` feeds the glow's static halo
  // and `color` paints the glyph. An operator who tints an icon and then finds
  // its glow still the brand colour would reasonably call that broken.
  const wrapperStyle =
    decor.color === undefined
      ? undefined
      : ({ "--icon-effect-color": decor.color } as CSSProperties);
  const glyphStyle = decor.color === undefined ? undefined : { color: decor.color };

  return { Glyph, effectClass, wrapperStyle, glyphStyle };
}
