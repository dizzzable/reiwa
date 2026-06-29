/**
 * plan-card-visual
 * ────────────────
 * Resolves the static visual for a tariff card on the `/plans` page from the
 * operator's per-plan `branding.planCardStyles[planId]`, falling back to a
 * deterministic auto gradient so unconfigured (and archived) plans still look
 * distinct from one another. Pure — no React, no WebGL (the tariff list stays
 * light; animated effects remain exclusive to the subscription carousel).
 */
import { buildTextureCss } from "@/lib/app-texture";
import type { Branding } from "@/types/branding";

/**
 * Deterministic gradient from a plan id. Same hash the WEB Reiwa configurator
 * preview uses, so the admin preview and the cabinet agree pixel-for-hue.
 */
export function autoPlanGradient(planId: string): string {
  let h = 0;
  for (let i = 0; i < planId.length; i += 1) {
    h = (h * 31 + planId.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 65% 32%))`;
}

export interface ResolvedPlanCardStyle {
  /** CSS background gradient for the card. */
  readonly gradient: string;
  /** Accent hex for price/name, or `null` to use the brand primary. */
  readonly accent: string | null;
  /** Operator-uploaded texture image URL (cover overlay), or `null`. */
  readonly textureUrl: string | null;
  /** CSS background-image for a built-in texture preset, or `null`. */
  readonly textureImage: string | null;
  /** CSS background-size for the preset texture tile, or `null`. */
  readonly textureSize: string | null;
}

/** Resolve the effective card style for a plan (configured → else auto). */
export function resolvePlanCardStyle(planId: string, branding: Branding): ResolvedPlanCardStyle {
  const style = branding.planCardStyles?.[planId];
  const gradient =
    style?.gradient && style.gradient.length > 0 ? style.gradient : autoPlanGradient(planId);
  const accent = style?.accent && style.accent.length > 0 ? style.accent : null;
  const textureUrl = style?.textureUrl && style.textureUrl.length > 0 ? style.textureUrl : null;

  let textureImage: string | null = null;
  let textureSize: string | null = null;
  if (!textureUrl && style?.texturePreset) {
    const css = buildTextureCss({
      pattern: style.texturePreset,
      color: accent ?? "#ffffff",
      background: "transparent",
      scale: 18,
      opacity: 0.5,
    });
    textureImage = css.backgroundImage;
    textureSize = css.backgroundSize;
  }

  return { gradient, accent, textureUrl, textureImage, textureSize };
}

/* ── colour helpers ─────────────────────────────────────────────────────── */

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Readable price colour: keeps the accent's HUE (so it still belongs to the
 * card) but forces a bright, vivid tone so the price always stands out against
 * the (typically dark, vignetted) card and never blends into it. Non-hex input
 * falls back to white.
 */
export function readablePriceColor(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "#ffffff";
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const L = Math.min(Math.max(l, 0.72), 0.85);
  const S = Math.max(s, 0.55);
  return hslToHex(h, S, L);
}
