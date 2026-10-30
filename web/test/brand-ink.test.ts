// @vitest-environment jsdom

/**
 * `--brand-ink`: the primary as drawn on a card (30.10.2026).
 *
 * The owner looked at «Конкурсы» on a light theme: «иконки смешиваются». Of
 * the panel's 104 light concept themes, 57 put the primary under 3:1 against
 * their own card. The themes below are real rows from that catalogue — the
 * three worst, and one whose primary is already fine — with the contrast
 * measured here by a formula of the test's own, not the module's.
 */
import { afterEach, describe, expect, it } from "vitest";

import { readableBrandInk } from "../src/lib/brand-ink";
import { applyBrandingToDocument } from "../src/lib/branding-document";
import { DEFAULT_BRANDING, DEFAULT_SURFACE_THEME, type Branding } from "../src/types/branding";

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** The card as the eye sees it: the surface at its opacity over the background. */
function card(surface: string, opacity: number, background: string): string {
  const s = rgb(surface);
  const b = rgb(background);
  return `#${s.map((c, i) => Math.round(c * opacity + b[i]! * (1 - opacity)).toString(16).padStart(2, "0")).join("")}`;
}

const LIGHT = [
  // The whole theme is one teal: primary, background and surface alike.
  { id: "concept-af", primary: "#67F0DB", bgPrimary: "#67F0DB", foreground: "#020A0D", surface: "#67F0DB", surfaceOpacity: 0.94 },
  { id: "concept-c", primary: "#E6FF58", bgPrimary: "#F5F2F7", foreground: "#09080D", surface: "#F4F3ED", surfaceOpacity: 0.94 },
  { id: "concept-ae", primary: "#F1F3F2", bgPrimary: "#FFFFFF", foreground: "#050605", surface: "#FEFEFE", surfaceOpacity: 0.94 },
] as const;

describe("readableBrandInk", () => {
  for (const theme of LIGHT) {
    it(`gives ${theme.id}'s pale primary 3:1 on its card, without turning into the text colour`, () => {
      const behind = card(theme.surface, theme.surfaceOpacity, theme.bgPrimary);
      expect(ratio(theme.primary, behind), "the premise: the bare primary vanishes").toBeLessThan(1.5);

      const ink = readableBrandInk(theme.primary, theme, theme.bgPrimary);

      expect(ratio(ink, behind)).toBeGreaterThanOrEqual(3);
      expect(ink.toLowerCase()).not.toBe(theme.foreground.toLowerCase());
    });
  }

  it("leaves a primary that already stands out exactly as the operator chose it", () => {
    const red = { foreground: "#090706", surface: "#FCF3F2", surfaceOpacity: 0.94 };
    expect(readableBrandInk("#C92F26", red, "#FFFFFF")).toBe("#C92F26");
    expect(readableBrandInk(DEFAULT_BRANDING.primary, DEFAULT_SURFACE_THEME, DEFAULT_BRANDING.bgPrimary)).toBe(
      DEFAULT_BRANDING.primary,
    );
  });

  it("lightens a dark primary on a dark card instead of darkening it", () => {
    const ink = readableBrandInk("#312e81", DEFAULT_SURFACE_THEME, "#0a0a0a");
    expect(luminance(ink)).toBeGreaterThan(luminance("#312e81"));
    expect(ratio(ink, card(DEFAULT_SURFACE_THEME.surface, DEFAULT_SURFACE_THEME.surfaceOpacity, "#0a0a0a"))).toBeGreaterThanOrEqual(3);
  });

  it("hands back what it cannot read rather than inventing a colour", () => {
    expect(readableBrandInk("oklch(70% 0.2 140)", DEFAULT_SURFACE_THEME, "#0a0a0a")).toBe("oklch(70% 0.2 140)");
  });
});

describe("applyBrandingToDocument", () => {
  afterEach(() => document.documentElement.removeAttribute("style"));

  it("writes the ink beside the primary", () => {
    const theme = LIGHT[1];
    const branding: Branding = {
      ...DEFAULT_BRANDING,
      primary: theme.primary,
      bgPrimary: theme.bgPrimary,
      surfaceTheme: { ...DEFAULT_SURFACE_THEME, foreground: theme.foreground, surface: theme.surface, surfaceOpacity: theme.surfaceOpacity },
    };
    applyBrandingToDocument(branding);
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--brand-primary")).toBe(theme.primary);
    expect(style.getPropertyValue("--brand-ink")).toBe(readableBrandInk(theme.primary, branding.surfaceTheme!, theme.bgPrimary));
    expect(style.getPropertyValue("--brand-ink")).not.toBe(theme.primary);
  });
});
