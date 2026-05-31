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
  readonly isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  locales: DEFAULT_PUBLIC_CONFIG.locales,
  defaultLocale: DEFAULT_PUBLIC_CONFIG.defaultLocale,
  defaultCurrency: DEFAULT_PUBLIC_CONFIG.defaultCurrency,
  customIcons: DEFAULT_PUBLIC_CONFIG.customIcons,
  isLoading: true,
});

const LOCALE_STORAGE_KEY = "reiwa_locale";

export function BrandingProvider({ children }: PropsWithChildren) {
  const { i18n } = useTranslation();

  const { data, isLoading } = useQuery<PublicConfig>({
    queryKey: ["public-config"],
    queryFn: getReiwaPublicConfig,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 2,
    refetchOnWindowFocus: false,
    placeholderData: DEFAULT_PUBLIC_CONFIG,
  });

  const config = data ?? DEFAULT_PUBLIC_CONFIG;

  // Apply branding tokens to :root whenever the payload changes.
  useEffect(() => {
    applyBrandingToDocument(config.branding);
  }, [config.branding]);

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
      isLoading,
    }),
    [config.branding, config.locales, config.defaultLocale, config.defaultCurrency, config.customIcons, isLoading],
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
