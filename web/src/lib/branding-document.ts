import {
  DEFAULT_SURFACE_THEME,
  type Branding,
} from "../types/branding";

/**
 * Legacy radius classes remain readable for snapshots created before the
 * independent card/item/pill geometry contract was introduced.
 */
const RADIUS_TOKENS: Readonly<
  Record<string, { readonly card: string; readonly item: string; readonly pill: string }>
> = {
  "rounded-none": { card: "0px", item: "0px", pill: "0px" },
  "rounded-lg": { card: "0.75rem", item: "0.5rem", pill: "0.75rem" },
  "rounded-xl": { card: "1rem", item: "0.75rem", pill: "9999px" },
  "rounded-2xl": { card: "1.5rem", item: "0.875rem", pill: "9999px" },
  "rounded-3xl": { card: "2rem", item: "1.125rem", pill: "9999px" },
  "rounded-full": { card: "2.5rem", item: "1.5rem", pill: "9999px" },
};

/**
 * Finish the synchronous `<head>` background handoff after a matching React
 * background layer has committed.
 */
export function clearBootstrapAppBackground(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.removeProperty("--bootstrap-app-background-color");
  root.style.removeProperty("--bootstrap-app-background-image");
  root.style.removeProperty("--bootstrap-app-background-size");
  delete root.dataset["bootstrapAppBackground"];
  delete root.dataset["bootstrapAppBackgroundKind"];
}

/**
 * Writes the current branding to CSS custom properties on `<html>`.
 *
 * Kept free of React and other runtime packages so the theme handoff can be
 * tested in the backend-only CI job as well as consumed by the web bundle.
 */
export function applyBrandingToDocument(branding: Branding): void {
  const root = document.documentElement;
  const surface = branding.surfaceTheme ?? DEFAULT_SURFACE_THEME;
  const legacyRadii =
    RADIUS_TOKENS[branding.borderRadius] ?? RADIUS_TOKENS["rounded-2xl"];
  const radii = branding.cornerRadii
    ? {
        card: `${Math.min(48, Math.max(0, branding.cornerRadii.cardPx))}px`,
        item: `${Math.min(32, Math.max(0, branding.cornerRadii.itemPx))}px`,
        pill: `${Math.min(9999, Math.max(0, branding.cornerRadii.pillPx))}px`,
      }
    : legacyRadii;
  const scheme = relativeLuminance(branding.bgPrimary) >= 0.42 ? "light" : "dark";

  root.style.setProperty("--brand-name", JSON.stringify(branding.brandName));
  root.style.setProperty("--brand-primary", branding.primary);
  root.style.setProperty("--brand-primary-fg", branding.primaryFg);
  root.style.setProperty("--brand-bg-primary", branding.bgPrimary);
  root.style.setProperty("--brand-bg-secondary", branding.bgSecondary);
  root.style.setProperty("--brand-card-gradient", branding.cardGradient);
  root.style.setProperty(
    "--brand-card-pattern",
    branding.cardPattern ?? "none",
  );
  root.style.setProperty("--brand-font", branding.fontFamily);
  root.style.setProperty("--brand-foreground", surface.foreground);
  root.style.setProperty("--brand-muted-foreground", surface.mutedForeground);
  root.style.setProperty("--brand-surface", surface.surface);
  root.style.setProperty("--brand-surface-high", surface.surfaceHigh);
  root.style.setProperty(
    "--color-surface",
    toRgba(surface.surface, surface.surfaceOpacity),
  );
  root.style.setProperty(
    "--color-surface-high",
    toRgba(surface.surfaceHigh, surface.surfaceHighOpacity),
  );
  root.style.setProperty(
    "--color-border-soft",
    toRgba(surface.borderSoft, surface.borderSoftOpacity),
  );
  root.style.setProperty(
    "--color-border-strong",
    toRgba(surface.borderStrong, surface.borderStrongOpacity),
  );
  root.style.setProperty("--foreground", surface.foreground);
  root.style.setProperty("--card-foreground", surface.foreground);
  root.style.setProperty("--popover-foreground", surface.foreground);
  root.style.setProperty("--secondary-foreground", surface.foreground);
  root.style.setProperty("--accent-foreground", surface.foreground);
  root.style.setProperty("--sidebar-foreground", surface.foreground);
  root.style.setProperty("--muted-foreground", surface.mutedForeground);
  root.style.setProperty("--radius-card", radii.card);
  root.style.setProperty("--radius-item", radii.item);
  root.style.setProperty("--radius-pill", radii.pill);
  root.style.setProperty("--radius", radii.item);
  root.style.setProperty("--glass-blur", `${surface.glassBlurPx}px`);
  root.style.colorScheme = scheme;
  root.classList.toggle("dark", scheme === "dark");
  root.dataset["themeScheme"] = scheme;
  if (branding.themePresetId) {
    root.dataset["themePreset"] = branding.themePresetId;
    root.dataset["themePresetVersion"] = String(branding.themePresetVersion ?? 1);
  } else {
    delete root.dataset["themePreset"];
    delete root.dataset["themePresetVersion"];
  }
  root.dataset["bgEffect"] = branding.bgEffect;

  const appBackground = branding.appBackground;
  const keepsBootstrapBackground =
    appBackground !== undefined &&
    (appBackground.kind === "gradient" ||
      appBackground.kind === "texture" ||
      (appBackground.kind === "effect" && appBackground.effect !== "NONE") ||
      (appBackground.kind === undefined && appBackground.effect !== "NONE"));
  if (!keepsBootstrapBackground) {
    clearBootstrapAppBackground();
  }
}

function toRgba(hex: string, opacity: number): string {
  const raw = hex.trim().replace(/^#/, "");
  const normalized =
    raw.length === 3 || raw.length === 4
      ? raw
          .slice(0, 3)
          .split("")
          .map((character) => character + character)
          .join("")
      : raw.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return hex;
  const alpha = Math.min(1, Math.max(0, opacity));
  return `rgba(${Number.parseInt(normalized.slice(0, 2), 16)}, ${Number.parseInt(
    normalized.slice(2, 4),
    16,
  )}, ${Number.parseInt(normalized.slice(4, 6), 16)}, ${alpha})`;
}

function relativeLuminance(hex: string): number {
  const raw = hex.trim().replace(/^#/, "");
  const normalized =
    raw.length === 3
      ? raw
          .split("")
          .map((character) => character + character)
          .join("")
      : raw.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0;
  const channel = (offset: number): number => {
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
