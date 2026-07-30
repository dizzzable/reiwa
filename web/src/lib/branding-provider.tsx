/**
 * BrandingProvider
 * ─────────────────
 * Bootstraps the SPA with the operator-configured branding (palette, fonts,
 * card gradient, background effect) and the locale catalogue from
 * rezeis-admin (`/api/v1/public-config`).
 *
 * Behaviour:
 *  - Mounts the SPA immediately with a validated local snapshot when one is
 *    available, otherwise `DEFAULT_PUBLIC_CONFIG`, so the first paint is
 *    deterministic even offline.
 *  - Fetches `/public-config` via React Query in the background. On success,
 *    it patches CSS custom properties on `<html>`, switches the i18n language
 *    according to `defaultLocale` (only if the user hasn't already chosen one
 *    via the language switcher / localStorage), and re-renders consumers via
 *    context.
 *  - Caches the response for 5 minutes (matches the backend ETag TTL); reads
 *    are served from cache between mounts.
 */

import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";

import { getReiwaPublicConfig } from "@/lib/api-client";
import {
  readPublicConfigSnapshot,
  writePublicConfigSnapshot,
} from "@/lib/public-config-snapshot";
import {
  selectBrandingProviderConfig,
  shouldPersistPublicConfig,
} from "@/lib/branding-provider-policy";
import {
  DEFAULT_BRANDING,
  DEFAULT_PUBLIC_CONFIG,
  DEFAULT_SURFACE_THEME,
  type Branding,
  type CustomIcon,
  type PublicConfig,
} from "@/types/branding";

interface BrandingContextValue {
  readonly branding: Branding;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly defaultCurrency: string;
  readonly customIcons: CustomIcon[];
  readonly botUsername: string | null;
  readonly supportUsername: string | null;
  readonly emailEnabled: boolean;
  readonly isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  locales: DEFAULT_PUBLIC_CONFIG.locales,
  defaultLocale: DEFAULT_PUBLIC_CONFIG.defaultLocale,
  defaultCurrency: DEFAULT_PUBLIC_CONFIG.defaultCurrency,
  customIcons: DEFAULT_PUBLIC_CONFIG.customIcons,
  botUsername: DEFAULT_PUBLIC_CONFIG.botUsername ?? null,
  supportUsername: DEFAULT_PUBLIC_CONFIG.supportUsername ?? null,
  emailEnabled: DEFAULT_PUBLIC_CONFIG.emailEnabled ?? false,
  isLoading: true,
});

const LOCALE_STORAGE_KEY = "reiwa_locale";

export function BrandingProvider({ children }: PropsWithChildren) {
  const { i18n } = useTranslation();
  const [snapshot] = useState(readPublicConfigSnapshot);

  const {
    data,
    dataUpdatedAt,
    isLoading,
    isPlaceholderData,
    isSuccess,
    refetch,
  } = useQuery<PublicConfig>({
    queryKey: ["public-config"],
    queryFn: getReiwaPublicConfig,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 2,
    refetchOnWindowFocus: false,
    // A valid browser snapshot is used only until the request resolves. With
    // no snapshot (or unavailable storage), this preserves the built-in first
    // paint defaults exactly as before.
    placeholderData: selectBrandingProviderConfig(undefined, snapshot),
  });

  // Refetch branding when the tab / Mini App regains visibility so an open
  // session picks up operator theme edits without a manual reload. Throttled
  // so rapid tab switches don't hammer the endpoint (the server-side cache
  // makes each call cheap regardless).
  useEffect(() => {
    let lastRefetch = 0;
    const THROTTLE_MS = 15_000;
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefetch < THROTTLE_MS) return;
      lastRefetch = now;
      void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  const config = selectBrandingProviderConfig(data, snapshot);

  // Apply branding tokens before the browser paints. In particular, a valid
  // last-known-good snapshot must never render one frame with the built-in
  // palette while the admin panel is unavailable.
  useLayoutEffect(() => {
    applyBrandingToDocument(config.branding);
  }, [config.branding]);

  // Persist only data confirmed by React Query as a real (non-placeholder)
  // successful result. A failed refresh leaves the last known-good snapshot
  // untouched for the next cold SPA boot.
  useEffect(() => {
    if (!shouldPersistPublicConfig(data, dataUpdatedAt, isPlaceholderData, isSuccess)) return;
    writePublicConfigSnapshot(data);
  }, [data, dataUpdatedAt, isPlaceholderData, isSuccess]);

  // Set the document (browser tab) title from the operator's webTitle,
  // falling back to projectName, then the brand name.
  useEffect(() => {
    const title =
      config.platformBranding?.webTitle?.trim() ||
      config.platformBranding?.projectName?.trim() ||
      config.branding.brandName?.trim();
    if (title) {
      document.title = title;
    }
  }, [config.platformBranding?.webTitle, config.platformBranding?.projectName, config.branding.brandName]);

  // Point the iOS "Add to Home Screen" icon at the operator's PWA icon / logo.
  // iOS reads `<link rel="apple-touch-icon">` from the DOM at install time, so
  // updating it here white-labels the home-screen icon on Safari (the dynamic
  // manifest covers Android/Chrome). Falls back to the static Reiwa icon.
  useEffect(() => {
    const icon =
      config.branding.pwaIconUrl?.trim() ||
      config.branding.logoUrl?.trim() ||
      "/icons/icon-192x192.png";
    let link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "apple-touch-icon";
      document.head.appendChild(link);
    }
    link.href = icon;
  }, [config.branding.pwaIconUrl, config.branding.logoUrl]);

  // White-label the browser-tab favicon (`<link rel="icon">`, hardcoded to
  // `/Reiwa-logo.svg` in index.html). The apple-touch-icon effect above only
  // covers the iOS home-screen install icon; the desktop/mobile browser tab
  // reads `rel="icon"` separately, so without this the operator's custom icon
  // shows on the installed PWA but NOT in the browser tab. Prefer the explicit
  // PWA icon, then the brand logo; fall back to the static Reiwa SVG.
  useEffect(() => {
    const favicon =
      config.branding.pwaIconUrl?.trim() ||
      config.branding.logoUrl?.trim() ||
      "/Reiwa-logo.svg";
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    // Drop the hardcoded `type="image/svg+xml"` so a PNG/ICO operator icon
    // isn't mis-typed; let the browser sniff the actual content type.
    link.removeAttribute("type");
    link.href = favicon;
  }, [config.branding.pwaIconUrl, config.branding.logoUrl]);

  // White-label the iOS home-screen app title. Safari bakes the value of
  // `<meta name="apple-mobile-web-app-title">` (hardcoded "Reiwa" in index.html)
  // into the installed icon label, so patch it from the operator brand name.
  useEffect(() => {
    const name = config.branding.brandName?.trim();
    if (!name) return;
    let meta = document.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-title"]',
    );
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "apple-mobile-web-app-title";
      document.head.appendChild(meta);
    }
    meta.content = name;
  }, [config.branding.brandName]);

  // Keep browser/PWA chrome in sync after a successful live refresh. The
  // synchronous head bootstrap covers cold starts; this effect covers theme
  // changes received while the application is already open.
  useEffect(() => {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = config.branding.bgPrimary;
  }, [config.branding.bgPrimary]);

  // Synchronise i18n with the operator-configured default locale, but only
  // when the user has not made an explicit choice yet.
  useEffect(() => {
    let userChosen: string | null = null;
    try {
      userChosen = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    if (userChosen) return;
    const candidate = config.defaultLocale;
    if (config.locales.includes(candidate) && i18n.language !== candidate) {
      void i18n.changeLanguage(candidate);
    }
  }, [config.defaultLocale, config.locales, i18n]);

  const value = useMemo<BrandingContextValue>(
    () => ({
      branding: config.branding,
      locales: config.locales,
      defaultLocale: config.defaultLocale,
      defaultCurrency: config.defaultCurrency,
      customIcons: config.customIcons ?? [],
      botUsername: config.botUsername ?? null,
      supportUsername: config.supportUsername ?? null,
      emailEnabled: config.emailEnabled ?? false,
      isLoading,
    }),
    [config.branding, config.locales, config.defaultLocale, config.defaultCurrency, config.customIcons, config.botUsername, config.supportUsername, config.emailEnabled, isLoading],
  );

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}

/**
 * Writes the current branding to CSS custom properties on `<html>`.
 *
 * This is the single point of truth for visual customisation: anything in the
 * SPA that wants to react to the operator's palette reads from these
 * variables (Tailwind classes, raw CSS, inline styles).
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
 * background layer has committed. Keeping this separate from the token update
 * prevents the session-loading shell from briefly exposing the plain fallback
 * colour between the bootstrap script and `<AppBackground>`.
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

  // There is no React background layer to perform a handoff for `none`, so
  // discard a stale bootstrap layer immediately. Custom backgrounds remain
  // in place until AppBackground commits its equivalent layer.
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
