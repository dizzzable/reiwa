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
  useCallback,
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
  type Branding,
  type BrandingThemeMode,
  type CustomIcon,
  type PublicConfig,
  resolveBrandingThemeMode,
} from "@/types/branding";
import { applyBrandingToDocument } from "@/lib/branding-document";

interface BrandingContextValue {
  readonly branding: Branding;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly defaultCurrency: string;
  readonly customIcons: CustomIcon[];
  readonly botUsername: string | null;
  readonly supportUsername: string | null;
  readonly emailEnabled: boolean;
  /** Effective representation of the operator-selected concept. */
  readonly themeMode: BrandingThemeMode;
  /** `true` only when the operator explicitly unlocked light/dark selection. */
  readonly canChooseThemeMode: boolean;
  /** Changes only light/dark for the selected concept; never its preset id. */
  readonly setThemeMode: (mode: BrandingThemeMode) => void;
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
  themeMode: "dark",
  canChooseThemeMode: false,
  setThemeMode: () => undefined,
  isLoading: true,
});

const LOCALE_STORAGE_KEY = "reiwa_locale";
const THEME_MODE_STORAGE_PREFIX = "reiwa_theme_mode";

interface ThemeModePreference {
  readonly key: string | null;
  readonly mode: BrandingThemeMode | null;
}

function themeModeStorageKey(branding: Branding): string | null {
  const presetId = branding.themePresetId?.trim();
  if (!presetId || !presetId.startsWith("concept-")) return null;
  return `${THEME_MODE_STORAGE_PREFIX}:${presetId}:${branding.themePresetVersion ?? 1}`;
}

function readStoredThemeMode(key: string | null): BrandingThemeMode | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

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
  const defaultThemeMode: BrandingThemeMode =
    config.branding.themeDefaultMode === "light" ? "light" : "dark";
  const themePreferenceKey = themeModeStorageKey(config.branding);
  const canChooseThemeMode =
    config.branding.themeModePolicy === "user-selectable" &&
    themePreferenceKey !== null &&
    config.branding.themeVariants !== null &&
    config.branding.themeVariants !== undefined;
  const [themePreference, setThemePreference] = useState<ThemeModePreference>(
    () => ({ key: null, mode: null }),
  );

  // The selected brightness belongs to the current concept identity. Keeping
  // only this primitive in state avoids duplicating the branding payload; the
  // effective visual is derived below from the admin source of truth.
  useLayoutEffect(() => {
    setThemePreference({
      key: themePreferenceKey,
      mode: canChooseThemeMode ? readStoredThemeMode(themePreferenceKey) : null,
    });
  }, [canChooseThemeMode, themePreferenceKey]);

  const themeMode =
    canChooseThemeMode && themePreference.key === themePreferenceKey && themePreference.mode
      ? themePreference.mode
      : defaultThemeMode;
  const effectiveBranding = useMemo(
    () => resolveBrandingThemeMode(config.branding, themeMode),
    [config.branding, themeMode],
  );
  const setThemeMode = useCallback(
    (mode: BrandingThemeMode): void => {
      if (!canChooseThemeMode || !themePreferenceKey) return;
      setThemePreference({ key: themePreferenceKey, mode });
      try {
        window.localStorage.setItem(themePreferenceKey, mode);
      } catch {
        // The visual change remains available for this session even when the
        // browser blocks storage (private/TMA restrictions).
      }
    },
    [canChooseThemeMode, themePreferenceKey],
  );

  // Apply branding tokens before the browser paints. In particular, a valid
  // last-known-good snapshot must never render one frame with the built-in
  // palette while the admin panel is unavailable.
  useLayoutEffect(() => {
    applyBrandingToDocument(effectiveBranding);
  }, [effectiveBranding]);

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
    meta.content = effectiveBranding.bgPrimary;
  }, [effectiveBranding.bgPrimary]);

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
      branding: effectiveBranding,
      locales: config.locales,
      defaultLocale: config.defaultLocale,
      defaultCurrency: config.defaultCurrency,
      customIcons: config.customIcons ?? [],
      botUsername: config.botUsername ?? null,
      supportUsername: config.supportUsername ?? null,
      emailEnabled: config.emailEnabled ?? false,
      themeMode,
      canChooseThemeMode,
      setThemeMode,
      // `placeholderData` is always defined (the selector falls back to the
      // snapshot, then to the built-in defaults), so React Query reports
      // `success` on the very first render and `isLoading` is false for the
      // whole life of the app. Consumers that must distinguish "operator
      // config has arrived" from "we are still painting defaults" — the
      // `?link=email` deep link is the live one — need the placeholder flag
      // folded in. Self-terminating: the placeholder branch only applies
      // while the query is `pending`, so a permanent fetch failure flips
      // `status` to `error`, clears `isPlaceholderData`, and releases the
      // waiters instead of hanging on defaults forever.
      isLoading: isLoading || isPlaceholderData,
    }),
    [effectiveBranding, config.locales, config.defaultLocale, config.defaultCurrency, config.customIcons, config.botUsername, config.supportUsername, config.emailEnabled, themeMode, canChooseThemeMode, setThemeMode, isLoading, isPlaceholderData],
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
