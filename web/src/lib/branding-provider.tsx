/**
 * BrandingProvider
 * ─────────────────
 * Bootstraps the SPA with the operator-configured branding (palette, fonts,
 * card gradient, background effect) and the locale catalogue from
 * rezeis-admin (`/api/v1/public-config`).
 *
 * Behaviour:
 *  - Mounts the SPA immediately with `DEFAULT_BRANDING` so the first paint
 *    has a deterministic look (no flash of unstyled content).
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
  useMemo,
  type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";

import { getReiwaPublicConfig } from "@/lib/api-client";
import {
  DEFAULT_BRANDING,
  DEFAULT_PUBLIC_CONFIG,
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
  emailEnabled: DEFAULT_PUBLIC_CONFIG.emailEnabled ?? false,
  isLoading: true,
});

const LOCALE_STORAGE_KEY = "reiwa_locale";

export function BrandingProvider({ children }: PropsWithChildren) {
  const { i18n } = useTranslation();

  const { data, isLoading, refetch } = useQuery<PublicConfig>({
    queryKey: ["public-config"],
    queryFn: getReiwaPublicConfig,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 2,
    refetchOnWindowFocus: false,
    placeholderData: DEFAULT_PUBLIC_CONFIG,
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

  const config = data ?? DEFAULT_PUBLIC_CONFIG;

  // Apply branding tokens to :root whenever the payload changes.
  useEffect(() => {
    applyBrandingToDocument(config.branding);
  }, [config.branding]);

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
      emailEnabled: config.emailEnabled ?? false,
      isLoading,
    }),
    [config.branding, config.locales, config.defaultLocale, config.defaultCurrency, config.customIcons, config.botUsername, config.emailEnabled, isLoading],
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
function applyBrandingToDocument(branding: Branding): void {
  const root = document.documentElement;
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
  root.dataset["bgEffect"] = branding.bgEffect;
}
