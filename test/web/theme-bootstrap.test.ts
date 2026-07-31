import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { DEFAULT_PUBLIC_CONFIG } from "../../web/src/types/branding.js";

const BOOTSTRAP_SOURCE = readFileSync(
  new URL("../../web/public/theme-bootstrap.js", import.meta.url),
  "utf8",
);
const INDEX_SOURCE = readFileSync(
  new URL("../../web/index.html", import.meta.url),
  "utf8",
);
const STORAGE_KEY = "reiwa_public_config_snapshot_v1";

function executeBootstrap(snapshot: unknown) {
  const properties = new Map<string, string>();
  const classes = new Set(["dark"]);
  const dataset: Record<string, string> = {};
  const themeColor = { content: "#0a0a0a" };
  const document = {
    title: "Reiwa",
    documentElement: {
      dataset,
      classList: {
        toggle: (name: string, force: boolean) =>
          force ? classes.add(name) : classes.delete(name),
      },
      style: {
        colorScheme: "",
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    },
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? themeColor : null,
  };
  const localStorage = {
    getItem: (key: string) =>
      key === STORAGE_KEY ? JSON.stringify(snapshot) : null,
  };

  runInNewContext(BOOTSTRAP_SOURCE, {
    document,
    window: { localStorage },
  });

  return { classes, dataset, document, properties, themeColor };
}

describe("pre-paint theme bootstrap", () => {
  it("loads as a same-origin CSP-compatible script before the React module", () => {
    const bootstrapTag = '<script src="/theme-bootstrap.js"></script>';
    const appTag = '<script type="module" src="/src/main.tsx"></script>';

    expect(INDEX_SOURCE).toContain(bootstrapTag);
    expect(INDEX_SOURCE).toContain(appTag);
    expect(INDEX_SOURCE.indexOf(bootstrapTag)).toBeLessThan(
      INDEX_SOURCE.indexOf(appTag),
    );
  });

  it("restores a valid light operator theme before the app bundle runs", () => {
    const snapshot = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        brandName: "Polar Reiwa",
        themePresetId: "concept-cz",
        themePresetVersion: 1,
        bgPrimary: "#f8f4e9",
        bgSecondary: "#eee7d8",
        borderRadius: "rounded-none",
        cornerRadii: { cardPx: 2, itemPx: 1, pillPx: 0 },
        appBackground: {
          ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
          kind: "gradient",
          gradient: "linear-gradient(135deg, #f8f4e9, #eee7d8)",
        },
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
      },
    };

    const result = executeBootstrap(snapshot);

    expect(result.properties.get("--brand-bg-primary")).toBe("#f8f4e9");
    expect(result.properties.get("--brand-foreground")).toBe("#191919");
    expect(result.properties.get("--color-surface")).toBe(
      "rgba(255, 253, 248, 0.9)",
    );
    expect(result.properties.get("--radius-card")).toBe("2px");
    expect(result.properties.get("--radius-item")).toBe("1px");
    expect(result.properties.get("--radius-pill")).toBe("0px");
    expect(result.properties.get("--bootstrap-app-background-image")).toContain(
      "linear-gradient(135deg, #f8f4e9, #eee7d8)",
    );
    expect(result.properties.get("--bootstrap-app-background-image")).toContain(
      "data:image/svg+xml",
    );
    expect(result.properties.get("--bootstrap-app-background-size")).toBe(
      "24px 24px, cover",
    );
    expect(result.properties.get("--bootstrap-app-background-blend")).toBe(
      "soft-light, normal",
    );
    expect(result.dataset["bootstrapAppBackground"]).toBe("true");
    expect(result.dataset["themeScheme"]).toBe("light");
    expect(result.dataset["themePreset"]).toBe("concept-cz");
    expect(result.classes.has("dark")).toBe(false);
    expect(result.themeColor.content).toBe("#f8f4e9");
    expect(result.document.title).toBe("Polar Reiwa");
  });

  it("restores a static texture without waiting for React", () => {
    const snapshot = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        appBackground: {
          ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
          kind: "texture",
          texture: {
            pattern: "grid",
            color: "#ffffff",
            background: "#101820",
            scale: 32,
            opacity: 0.2,
          },
        },
      },
    };

    const result = executeBootstrap(snapshot);

    expect(result.properties.get("--bootstrap-app-background-color")).toBe(
      "#101820",
    );
    expect(result.properties.get("--bootstrap-app-background-image")).toContain(
      "linear-gradient(180deg, rgb(0 0 0 /",
    );
    expect(result.properties.get("--bootstrap-app-background-image")).toContain(
      "data:image/svg+xml",
    );
    expect(result.properties.get("--bootstrap-app-background-size")).toBe(
      "cover, 32px 32px",
    );
    expect(result.dataset["bootstrapAppBackgroundKind"]).toBe("texture");
  });

  it("uses the configured gradient as a static fallback for a legacy effect snapshot", () => {
    const currentBackground = DEFAULT_PUBLIC_CONFIG.branding.appBackground!;
    const legacyBackground = {
      effect: "aurora",
      props: currentBackground.props,
      opacity: currentBackground.opacity,
      gradient:
        "radial-gradient(circle at 20% 10%, #6750a4, transparent 60%), linear-gradient(135deg, #090711, #171126)",
      texture: currentBackground.texture,
    };
    const snapshot = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        appBackground: legacyBackground,
      },
    };

    const result = executeBootstrap(snapshot);

    expect(result.properties.get("--bootstrap-app-background-image")).toBe(
      legacyBackground.gradient,
    );
    expect(result.dataset["bootstrapAppBackground"]).toBe("true");
    expect(result.dataset["bootstrapAppBackgroundKind"]).toBe("effect");
  });

  it("prepends the same readability veil used by the runtime shell for AM", () => {
    const snapshot = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        themePresetId: "concept-am",
        themePresetVersion: 1,
        appBackground: {
          ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
          kind: "gradient",
          gradient:
            "linear-gradient(180deg, #DFA98B 0%, #DFA98B 18%, #8E6D72 100%)",
          texture: {
            pattern: "diagonal",
            color: "#8f5b54",
            background: "#DFA98B",
            scale: 28,
            opacity: 0.14,
          },
        },
        surfaceTheme: {
          ...DEFAULT_PUBLIC_CONFIG.branding.surfaceTheme!,
          foreground: "#FFF7EF",
          mutedForeground: "#D6B7AD",
        },
      },
    };

    const result = executeBootstrap(snapshot);
    const image = result.properties.get("--bootstrap-app-background-image");

    expect(image).toContain("linear-gradient(180deg, rgb(0 0 0 /");
    expect(image).toContain("data:image/svg+xml");
    expect(image).toContain("#DFA98B");
    expect(result.properties.get("--bootstrap-app-background-size")).toBe(
      "cover, 28px 28px, cover",
    );
    expect(result.properties.get("--bootstrap-app-background-blend")).toBe(
      "normal, soft-light, normal",
    );
  });

  it("mirrors the medium-muted runtime fix for concept-a-like dark shells", () => {
    const snapshot = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        themePresetId: "concept-a",
        themePresetVersion: 1,
        appBackground: {
          ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
          kind: "gradient",
          gradient:
            "linear-gradient(180deg, #351411 0%, #4b201c 58%, #5c2d27 100%)",
          texture: {
            pattern: "cross",
            color: "#8b4c42",
            background: "#351411",
            scale: 28,
            opacity: 0.12,
          },
        },
        surfaceTheme: {
          ...DEFAULT_PUBLIC_CONFIG.branding.surfaceTheme!,
          foreground: "#E8D5CB",
          mutedForeground: "#8A807B",
        },
      },
    };

    const result = executeBootstrap(snapshot);
    const image = result.properties.get("--bootstrap-app-background-image");

    expect(image).toContain("linear-gradient(180deg, rgb(0 0 0 /");
    expect(image).toContain("#351411");
    expect(result.properties.get("--bootstrap-app-background-size")).toBe(
      "cover, 28px 28px, cover",
    );
    expect(result.properties.get("--bootstrap-app-background-blend")).toBe(
      "normal, soft-light, normal",
    );
  });

  it("restores old snapshots without appBackground using the branded solid fallback", () => {
    const {
      appBackground: _appBackground,
      cornerRadii: _cornerRadii,
      ...legacyBranding
    } =
      DEFAULT_PUBLIC_CONFIG.branding;
    const result = executeBootstrap({
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...legacyBranding,
        brandName: "Legacy Reiwa",
        bgPrimary: "#10141c",
      },
    });

    expect(result.properties.get("--brand-bg-primary")).toBe("#10141c");
    expect(
      result.properties.has("--bootstrap-app-background-image"),
    ).toBe(false);
    expect(result.dataset["bootstrapAppBackground"]).toBeUndefined();
    expect(result.document.title).toBe("Legacy Reiwa");
  });

  it("rejects localStorage CSS image loaders while retaining safe theme tokens", () => {
    const result = executeBootstrap({
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        bgPrimary: "#121820",
        cardGradient: 'url("https://attacker.invalid/card.png")',
        cardPattern:
          'linear-gradient(#fff, #000), url("https://attacker.invalid/pattern.png")',
        appBackground: {
          ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
          kind: "gradient",
          gradient: 'url("https://attacker.invalid/background.png")',
        },
      },
    });

    expect(result.properties.get("--brand-bg-primary")).toBe("#121820");
    expect(result.properties.has("--brand-card-gradient")).toBe(false);
    expect(result.properties.has("--brand-card-pattern")).toBe(false);
    expect(
      result.properties.has("--bootstrap-app-background-image"),
    ).toBe(false);
    expect(result.dataset["bootstrapAppBackground"]).toBeUndefined();
  });

  it("does not flash a gradient for an explicitly disabled effect", () => {
    const result = executeBootstrap({
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        appBackground: {
          ...DEFAULT_PUBLIC_CONFIG.branding.appBackground,
          kind: "effect",
          effect: "NONE",
          gradient: "linear-gradient(135deg, #101820, #263747)",
        },
      },
    });

    expect(
      result.properties.has("--bootstrap-app-background-image"),
    ).toBe(false);
    expect(result.dataset["bootstrapAppBackground"]).toBeUndefined();
  });

  it("leaves the built-in theme untouched for a malformed snapshot", () => {
    const result = executeBootstrap({
      branding: {
        primary: "not-a-colour",
        primaryFg: "#ffffff",
        bgPrimary: "#ffffff",
        bgSecondary: "#eeeeee",
        fontFamily: "Geist",
      },
    });

    expect(result.properties.size).toBe(0);
    expect(result.classes.has("dark")).toBe(true);
    expect(result.themeColor.content).toBe("#0a0a0a");
    expect(result.document.title).toBe("Reiwa");
  });
});
