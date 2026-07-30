import { afterEach, describe, expect, it, vi } from "vitest";

import { applyBrandingToDocument } from "../../web/src/lib/branding-provider.js";
import {
  selectBrandingProviderConfig,
  shouldPersistPublicConfig,
} from "../../web/src/lib/branding-provider-policy.js";
import {
  DEFAULT_PUBLIC_CONFIG,
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
