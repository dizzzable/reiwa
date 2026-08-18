import { afterEach, describe, expect, it, vi } from "vitest";

import { applyBrandingToDocument } from "../../web/src/lib/branding-document.js";
import {
  PUBLIC_CONFIG_RETRY_INTERVAL_MS,
  publicConfigRefetchInterval,
  selectBrandingProviderConfig,
  shouldPersistPublicConfig,
  shouldReportDefaultsPaint,
} from "../../web/src/lib/branding-provider-policy.js";
import {
  DEFAULT_PUBLIC_CONFIG,
  resolveBrandingThemeMode,
  type PublicConfig,
} from "../../web/src/types/branding.js";

const STORED_SNAPSHOT: PublicConfig = {
  ...DEFAULT_PUBLIC_CONFIG,
  branding: {
    ...DEFAULT_PUBLIC_CONFIG.branding,
    brandName: "Stored Northern Lights",
    primary: "#6750a4",
  },
};

describe("BrandingProvider snapshot fallback", () => {
  it("uses the stored snapshot on first paint before query data exists", () => {
    expect(selectBrandingProviderConfig(undefined, STORED_SNAPSHOT)).toBe(STORED_SNAPSHOT);
  });

  it("replaces the stored snapshot only when a fetched config is available", () => {
    expect(selectBrandingProviderConfig(DEFAULT_PUBLIC_CONFIG, STORED_SNAPSHOT)).toBe(
      DEFAULT_PUBLIC_CONFIG,
    );
  });

  it("does not make a failed fetch eligible to overwrite the stored snapshot", () => {
    expect(shouldPersistPublicConfig(undefined, 0, true, false)).toBe(false);
    expect(shouldPersistPublicConfig(STORED_SNAPSHOT, Date.now(), true, true)).toBe(false);
    expect(shouldPersistPublicConfig(STORED_SNAPSHOT, Date.now(), false, true)).toBe(true);
  });

  it("falls all the way to the built-in identity only when BOTH carriers are empty", () => {
    // The state in the field report: a client with no stored snapshot whose
    // fetch did not land shows the cabinet's own brand, not the operator's.
    // A client that merely lost the fetch keeps the operator identity, which
    // is why the same install can look correct on one device and stock on
    // another without anything being wrong with the device.
    expect(selectBrandingProviderConfig(undefined, null)).toBe(DEFAULT_PUBLIC_CONFIG);
    expect(selectBrandingProviderConfig(undefined, STORED_SNAPSHOT)).not.toBe(
      DEFAULT_PUBLIC_CONFIG,
    );
  });
});

describe("public-config recovery after a failed bootstrap", () => {
  it("keeps retrying while no operator payload has ever arrived", () => {
    expect(publicConfigRefetchInterval(undefined)).toBe(PUBLIC_CONFIG_RETRY_INTERVAL_MS);
    // A cadence of zero/false here is the defect this exists to prevent: the
    // query has no retryer of its own any more (`retry: false` — React Query's
    // parks rather than fails whenever the platform reports the document
    // hidden), so this poll is the only thing that re-triggers the request for
    // the life of the document.
    expect(PUBLIC_CONFIG_RETRY_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("stops retrying for good once a payload is in the cache", () => {
    expect(publicConfigRefetchInterval(STORED_SNAPSHOT)).toBe(false);
    // Even a payload that happens to equal the built-in shape counts: it came
    // from the server, so it is the operator's answer and not a fallback.
    expect(publicConfigRefetchInterval(DEFAULT_PUBLIC_CONFIG)).toBe(false);
  });
});

describe("painting built-in defaults is reported, never silent", () => {
  it("reports once the fetch has actually failed with nothing to fall back on", () => {
    expect(shouldReportDefaultsPaint(true, undefined, null)).toBe(true);
  });

  it("stays silent during the ordinary first paint", () => {
    // While the query is pending the provider renders DEFAULT_PUBLIC_CONFIG
    // through `placeholderData`. That is the designed first frame, not an
    // outage, and reporting it would bury the real signal in noise.
    expect(shouldReportDefaultsPaint(false, DEFAULT_PUBLIC_CONFIG, null)).toBe(false);
  });

  it("stays silent when a stored snapshot is still carrying the operator identity", () => {
    // The failure is real, but the subscriber sees the right cabinet — this
    // is the case that hid the defect on returning devices.
    expect(shouldReportDefaultsPaint(true, undefined, STORED_SNAPSHOT)).toBe(false);
  });

  it("stays silent when the payload arrived", () => {
    expect(shouldReportDefaultsPaint(false, STORED_SNAPSHOT, null)).toBe(false);
  });
});

describe("operator concept mode resolution", () => {
  it("changes only brightness of the selected concept, never its identity", () => {
    const branding = {
      ...DEFAULT_PUBLIC_CONFIG.branding,
      themePresetId: "concept-cu",
      themePresetVersion: 2,
      themeModePolicy: "user-selectable" as const,
      themeDefaultMode: "dark" as const,
      subscriptionCardText: { mode: "custom" as const, color: "#102030" },
      themeVariants: {
        light: {
          primary: "#165eff",
          primaryFg: "#ffffff",
          bgPrimary: "#f5f8ff",
          bgSecondary: "#eef3ff",
          cardGradient: "linear-gradient(135deg, #f5f8ff, #b8d0ff)",
          cardPattern: null,
          subscriptionCardText: { mode: "dark" as const, color: null },
          cardEffect: "aurora" as const,
          cardEffectProps: {},
          cardEffectOpacity: 0.8,
          cardEffectsByIndex: [],
          bgEffect: "NONE" as const,
          appBackground: { ...DEFAULT_PUBLIC_CONFIG.branding.appBackground! },
          borderRadius: "rounded-none",
          cornerRadii: { cardPx: 0, itemPx: 0, pillPx: 0 },
          fontFamily: "Archivo, sans-serif",
          surfaceTheme: { ...DEFAULT_PUBLIC_CONFIG.branding.surfaceTheme! },
        },
        dark: {
          primary: "#8cb4ff",
          primaryFg: "#000000",
          bgPrimary: "#0c1324",
          bgSecondary: "#121d36",
          cardGradient: "linear-gradient(135deg, #0c1324, #293f70)",
          cardPattern: null,
          subscriptionCardText: { mode: "light" as const, color: null },
          cardEffect: "aurora" as const,
          cardEffectProps: {},
          cardEffectOpacity: 0.8,
          cardEffectsByIndex: [],
          bgEffect: "NONE" as const,
          appBackground: { ...DEFAULT_PUBLIC_CONFIG.branding.appBackground! },
          borderRadius: "rounded-none",
          cornerRadii: { cardPx: 0, itemPx: 0, pillPx: 0 },
          fontFamily: "Archivo, sans-serif",
          surfaceTheme: { ...DEFAULT_PUBLIC_CONFIG.branding.surfaceTheme! },
        },
      },
    };

    const effective = resolveBrandingThemeMode(branding, "light");

    expect(effective.themePresetId).toBe("concept-cu");
    expect(effective.themePresetVersion).toBe(2);
    expect(effective.themeModePolicy).toBe("user-selectable");
    expect(effective.primary).toBe("#165eff");
    expect(effective.bgPrimary).toBe("#f5f8ff");
    // Even a stale public snapshot must not turn the global operator choice
    // into a brightness-specific policy.
    expect(effective.subscriptionCardText).toEqual({
      mode: "custom",
      color: "#102030",
    });
    // Geometry and typeface follow the same rule as the card text above, and
    // this line used to contradict it: it asserted the variant's radius won,
    // which is what made the panel's font and radius controls do nothing in the
    // cabinet. The variants are the concept preset's snapshot; the operator
    // edits these on the root afterwards, and the panel offers no per-mode
    // control for either.
    expect(effective.borderRadius).toBe(DEFAULT_PUBLIC_CONFIG.branding.borderRadius);
    expect(effective.borderRadius).not.toBe("rounded-none");
    expect(effective.fontFamily).toBe(DEFAULT_PUBLIC_CONFIG.branding.fontFamily);
    expect(effective.fontFamily).not.toBe("Archivo, sans-serif");
    // Brightness still comes from the variant — this is the half that must not
    // move, or a light theme renders light text on a light background.
    expect(effective.surfaceTheme).toEqual(branding.themeVariants.light.surfaceTheme);
    expect(effective.themeVariants).toBe(branding.themeVariants);
  });

  it("keeps an explicit operator card gradient after both persisted brightness variants resolve", () => {
    const operatorGradient = "linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)";
    const operatorSlots = [
      {
        cardEffect: "paperWarp" as const,
        cardEffectProps: { speed: 1.1 },
        cardEffectOpacity: 0.86,
        // null is intentional: the slot inherits the selected operator card.
        cardGradient: null,
      },
    ];
    const makeVariant = (primary: string, bgPrimary: string) => ({
      primary,
      primaryFg: "#ffffff",
      bgPrimary,
      bgSecondary: bgPrimary,
      cardGradient: operatorGradient,
      cardPattern: null,
      subscriptionCardText: { mode: "auto" as const, color: null },
      cardEffect: "aurora" as const,
      cardEffectProps: {},
      cardEffectOpacity: 0.6,
      cardEffectsByIndex: operatorSlots,
      bgEffect: "NONE" as const,
      appBackground: { ...DEFAULT_PUBLIC_CONFIG.branding.appBackground! },
      borderRadius: "rounded-xl",
      cornerRadii: { cardPx: 16, itemPx: 12, pillPx: 9999 },
      fontFamily: "Inter, sans-serif",
      surfaceTheme: { ...DEFAULT_PUBLIC_CONFIG.branding.surfaceTheme! },
    });
    const branding = {
      ...DEFAULT_PUBLIC_CONFIG.branding,
      cardGradient: operatorGradient,
      cardEffectsByIndex: operatorSlots,
      themeVariants: {
        light: makeVariant("#165eff", "#f5f8ff"),
        dark: makeVariant("#8cb4ff", "#0c1324"),
      },
    };

    for (const mode of ["light", "dark"] as const) {
      const effective = resolveBrandingThemeMode(branding, mode);
      expect(effective.cardGradient).toBe(operatorGradient);
      expect(effective.cardEffectsByIndex).toEqual(operatorSlots);
      expect(effective.cardEffectsByIndex[0]?.cardGradient).toBeNull();
    }
  });

  it("keeps the operator's global and positional card effects above a brightness variant", () => {
    const lightVariant = {
      primary: "#165eff",
      primaryFg: "#ffffff",
      bgPrimary: "#f5f8ff",
      bgSecondary: "#eef3ff",
      cardGradient: "linear-gradient(135deg, #f5f8ff, #b8d0ff)",
      cardPattern: null,
      subscriptionCardText: { mode: "custom" as const, color: "#102030" },
      cardEffect: "rippleGrid" as const,
      cardEffectProps: { gridSize: 18 },
      cardEffectOpacity: 0.4,
      cardEffectsByIndex: [
        {
          cardEffect: "aurora" as const,
          cardEffectProps: { speed: 0.2 },
          cardEffectOpacity: 0.3,
          cardGradient: "linear-gradient(#fff, #b8d0ff)",
        },
      ],
      bgEffect: "NONE" as const,
      appBackground: { ...DEFAULT_PUBLIC_CONFIG.branding.appBackground! },
      borderRadius: "rounded-xl",
      cornerRadii: { cardPx: 16, itemPx: 12, pillPx: 9999 },
      fontFamily: "Inter, sans-serif",
      surfaceTheme: { ...DEFAULT_PUBLIC_CONFIG.branding.surfaceTheme! },
    };
    const branding = {
      ...DEFAULT_PUBLIC_CONFIG.branding,
      cardEffect: "paperGrain" as const,
      cardEffectProps: { speed: 0.7 },
      cardEffectOpacity: 0.68,
      cardEffectsByIndex: [
        {
          cardEffect: "paperWarp" as const,
          cardEffectProps: { speed: 1.1 },
          cardEffectOpacity: 0.86,
          cardGradient: "linear-gradient(135deg, #2a0c35, #ef62a5)",
        },
      ],
      subscriptionCardText: { mode: "custom" as const, color: "#102030" },
      themeVariants: {
        light: lightVariant,
        dark: lightVariant,
      },
    };

    const effective = resolveBrandingThemeMode(branding, "light");

    expect(effective.cardGradient).toBe(
      "linear-gradient(135deg, #f5f8ff, #b8d0ff)",
    );
    expect(effective.cardEffect).toBe("paperGrain");
    expect(effective.cardEffectProps).toEqual({ speed: 0.7 });
    expect(effective.cardEffectOpacity).toBe(0.68);
    expect(effective.cardEffectsByIndex).toEqual(branding.cardEffectsByIndex);
    expect(effective.subscriptionCardText).toEqual({
      mode: "custom",
      color: "#102030",
    });
  });
});

describe("BrandingProvider document tokens", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies preset metadata, semantic surfaces and radius tokens", () => {
    const properties = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const classes = new Set(["dark"]);
    const style = {
      colorScheme: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    };
    vi.stubGlobal("document", {
      documentElement: {
        style,
        dataset,
        classList: {
          toggle: (name: string, force: boolean) =>
            force ? classes.add(name) : classes.delete(name),
        },
      },
    });

    applyBrandingToDocument({
      ...DEFAULT_PUBLIC_CONFIG.branding,
      themePresetId: "concept-cz",
      themePresetVersion: 1,
      bgPrimary: "#f8f4e9",
      borderRadius: "rounded-none",
      cornerRadii: { cardPx: 2, itemPx: 1, pillPx: 0 },
      surfaceTheme: {
        foreground: "#191919",
        mutedForeground: "#64605a",
        surface: "#fffdf8",
        surfaceHigh: "#f1ebdf",
        borderSoft: "#191919",
        borderStrong: "#000000",
        surfaceOpacity: 0.9,
        surfaceHighOpacity: 0.96,
        borderSoftOpacity: 0.12,
        borderStrongOpacity: 0.22,
        glassBlurPx: 0,
      },
    });

    expect(dataset["themePreset"]).toBe("concept-cz");
    expect(dataset["themePresetVersion"]).toBe("1");
    expect(dataset["themeScheme"]).toBe("light");
    expect(style.colorScheme).toBe("light");
    expect(classes.has("dark")).toBe(false);
    expect(properties.get("--foreground")).toBe("#191919");
    expect(properties.get("--color-surface")).toBe("rgba(255, 253, 248, 0.9)");
    expect(properties.get("--radius-card")).toBe("2px");
    expect(properties.get("--radius-item")).toBe("1px");
    expect(properties.get("--radius-pill")).toBe("0px");
    expect(properties.get("--glass-blur")).toBe("0px");
  });

  it("retains the cold-boot layer until a custom React background commits", () => {
    const properties = new Map<string, string>([
      ["--bootstrap-app-background-color", "#101820"],
      [
        "--bootstrap-app-background-image",
        "linear-gradient(135deg, #101820, #263747)",
      ],
      ["--bootstrap-app-background-size", "cover"],
    ]);
    const dataset: Record<string, string> = {
      bootstrapAppBackground: "true",
      bootstrapAppBackgroundKind: "gradient",
    };
    vi.stubGlobal("document", {
      documentElement: {
        style: {
          colorScheme: "",
          setProperty: (name: string, value: string) =>
            properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
        dataset,
        classList: { toggle: () => undefined },
      },
    });

    applyBrandingToDocument({
      ...DEFAULT_PUBLIC_CONFIG.branding,
      appBackground: {
        ...DEFAULT_PUBLIC_CONFIG.branding.appBackground!,
        kind: "gradient",
        gradient: "linear-gradient(135deg, #101820, #263747)",
      },
    });

    expect(properties.get("--bootstrap-app-background-image")).toBe(
      "linear-gradient(135deg, #101820, #263747)",
    );
    expect(dataset["bootstrapAppBackground"]).toBe("true");
  });

  it("clears a stale cold-boot layer when the effective background is none", () => {
    const properties = new Map<string, string>([
      ["--bootstrap-app-background-color", "#101820"],
      [
        "--bootstrap-app-background-image",
        "linear-gradient(135deg, #101820, #263747)",
      ],
      ["--bootstrap-app-background-size", "cover"],
    ]);
    const dataset: Record<string, string> = {
      bootstrapAppBackground: "true",
      bootstrapAppBackgroundKind: "gradient",
    };
    vi.stubGlobal("document", {
      documentElement: {
        style: {
          colorScheme: "",
          setProperty: (name: string, value: string) =>
            properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
        dataset,
        classList: { toggle: () => undefined },
      },
    });

    applyBrandingToDocument({
      ...DEFAULT_PUBLIC_CONFIG.branding,
      appBackground: {
        ...DEFAULT_PUBLIC_CONFIG.branding.appBackground!,
        kind: "none",
      },
    });

    expect(
      properties.has("--bootstrap-app-background-image"),
    ).toBe(false);
    expect(dataset["bootstrapAppBackground"]).toBeUndefined();
    expect(dataset["bootstrapAppBackgroundKind"]).toBeUndefined();
  });
});
