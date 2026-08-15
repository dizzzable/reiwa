import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { applyBrandingToDocument } from "../../web/src/lib/branding-document.js";
import {
  DEFAULT_PUBLIC_CONFIG,
  resolveBrandingThemeMode,
  type AppBackground,
  type Branding,
  type BrandingThemeMode,
  type BrandingThemeVariant,
  type SurfaceTheme,
} from "../../web/src/types/branding.js";

const BOOTSTRAP_SOURCE = readFileSync(
  new URL("../../web/public/theme-bootstrap.js", import.meta.url),
  "utf8",
);
const INDEX_SOURCE = readFileSync(
  new URL("../../web/index.html", import.meta.url),
  "utf8",
);
const STORAGE_KEY = "reiwa_public_config_snapshot_v1";

interface BootstrapStorage {
  /** Extra localStorage entries — the persisted brightness choice lives here. */
  readonly entries?: Readonly<Record<string, string>>;
  /** Keys whose read throws, the way a locked-down browser answers. */
  readonly blocked?: readonly string[];
}

function executeBootstrap(snapshot: unknown, storage: BootstrapStorage = {}) {
  const properties = new Map<string, string>();
  const classes = new Set(["dark"]);
  const dataset: Record<string, string> = {};
  const themeColor = { content: "#0a0a0a" };
  const reads: string[] = [];
  const entries = new Map(Object.entries(storage.entries ?? {}));
  const blocked = new Set(storage.blocked ?? []);
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
    getItem: (key: string): string | undefined | null => {
      reads.push(key);
      if (blocked.has(key)) throw new Error("storage is unavailable");
      if (key === STORAGE_KEY) return JSON.stringify(snapshot);
      return entries.get(key) ?? null;
    },
  };

  runInNewContext(BOOTSTRAP_SOURCE, {
    document,
    window: { localStorage },
  });

  return { classes, dataset, document, properties, reads, themeColor };
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

/* ------------------------------------------------------------------------- *
 * Brightness — the half of the theme this script used to ignore entirely.
 *
 * The subscriber's light/dark choice lives in its own key
 * (`reiwa_theme_mode:<presetId>:<version>`) and the two rendered palettes live
 * in `branding.themeVariants`. Before these specs the pre-paint script read
 * neither: it painted the ROOT palette, which is the dark rendering for every
 * concept that ships one. So a subscriber who had chosen "light", and whose
 * choice survived the reload, still got a full dark repaint on every cold start
 * until the bundle arrived — the exact flash this file exists to prevent.
 * ------------------------------------------------------------------------- */

const CONCEPT_ID = "concept-cx";
const CONCEPT_VERSION = 1;
const DARK_APP_GRADIENT =
  "linear-gradient(180deg, #090706 0%, #171311 60%, #241C18 100%)";
const LIGHT_APP_GRADIENT =
  "linear-gradient(180deg, #FFFFFF 0%, #FCF3F2 60%, #F4E7E5 100%)";

function themeModeKey(
  presetId: string,
  version: number | string = CONCEPT_VERSION,
): string {
  return `reiwa_theme_mode:${presetId}:${version}`;
}

const DARK_SURFACE: SurfaceTheme = {
  foreground: "#F8F5F1",
  mutedForeground: "#B9AFA6",
  surface: "#171311",
  surfaceHigh: "#231D1A",
  borderSoft: "#F8F5F1",
  borderStrong: "#FFFFFF",
  surfaceOpacity: 0.72,
  surfaceHighOpacity: 0.86,
  borderSoftOpacity: 0.08,
  borderStrongOpacity: 0.16,
  glassBlurPx: 16,
};

const LIGHT_SURFACE: SurfaceTheme = {
  foreground: "#090706",
  mutedForeground: "#6B605A",
  surface: "#FCF3F2",
  surfaceHigh: "#F4E7E5",
  borderSoft: "#090706",
  borderStrong: "#000000",
  surfaceOpacity: 0.9,
  surfaceHighOpacity: 0.96,
  borderSoftOpacity: 0.12,
  borderStrongOpacity: 0.22,
  glassBlurPx: 12,
};

function conceptVariant(
  overrides: Partial<BrandingThemeVariant> = {},
): BrandingThemeVariant {
  return {
    primary: "#E4785F",
    primaryFg: "#090706",
    bgPrimary: "#090706",
    bgSecondary: "#171311",
    cardGradient: "linear-gradient(135deg, #090706 0%, #E4785F 100%)",
    cardPattern: null,
    cardEffect: DEFAULT_PUBLIC_CONFIG.branding.cardEffect,
    cardEffectProps: {},
    cardEffectOpacity: 1,
    cardEffectsByIndex: [],
    bgEffect: DEFAULT_PUBLIC_CONFIG.branding.bgEffect,
    appBackground: {
      ...(DEFAULT_PUBLIC_CONFIG.branding.appBackground as AppBackground),
      kind: "gradient",
      gradient: DARK_APP_GRADIENT,
    },
    borderRadius: "rounded-2xl",
    cornerRadii: { cardPx: 24, itemPx: 14, pillPx: 9999 },
    fontFamily: "Geist Variable, system-ui, sans-serif",
    surfaceTheme: DARK_SURFACE,
    ...overrides,
  };
}

/** The concept's dark rendering — identical to the root the panel mirrors. */
const DARK_VARIANT = conceptVariant();

/** The concept's light rendering — nothing here reaches the root branding. */
const LIGHT_VARIANT = conceptVariant({
  primary: "#B0472B",
  primaryFg: "#FFFFFF",
  bgPrimary: "#FFFFFF",
  bgSecondary: "#FCF3F2",
  cardGradient: "linear-gradient(135deg, #FFFFFF 0%, #B0472B 100%)",
  surfaceTheme: LIGHT_SURFACE,
  appBackground: {
    ...(DEFAULT_PUBLIC_CONFIG.branding.appBackground as AppBackground),
    kind: "gradient",
    gradient: LIGHT_APP_GRADIENT,
  },
});

function conceptBranding(overrides: Partial<Branding> = {}): Branding {
  return {
    ...DEFAULT_PUBLIC_CONFIG.branding,
    brandName: "Cocoa Reiwa",
    themePresetId: CONCEPT_ID,
    themePresetVersion: CONCEPT_VERSION,
    themeModePolicy: "user-selectable",
    themeDefaultMode: "dark",
    themeVariants: { light: LIGHT_VARIANT, dark: DARK_VARIANT },
    // The root carries the dark rendering, exactly as the admin panel writes it.
    primary: DARK_VARIANT.primary,
    primaryFg: DARK_VARIANT.primaryFg,
    bgPrimary: DARK_VARIANT.bgPrimary,
    bgSecondary: DARK_VARIANT.bgSecondary,
    cardGradient: DARK_VARIANT.cardGradient,
    cardPattern: DARK_VARIANT.cardPattern,
    surfaceTheme: DARK_SURFACE,
    appBackground: DARK_VARIANT.appBackground,
    ...overrides,
  };
}

function conceptSnapshot(overrides: Partial<Branding> = {}) {
  return { ...DEFAULT_PUBLIC_CONFIG, branding: conceptBranding(overrides) };
}

describe("pre-paint brightness selection", () => {
  it("paints the brightness the subscriber chose, not the concept's default", () => {
    const result = executeBootstrap(conceptSnapshot(), {
      entries: { [themeModeKey(CONCEPT_ID)]: "light" },
    });

    expect(result.properties.get("--brand-bg-primary")).toBe("#FFFFFF");
    expect(result.properties.get("--brand-bg-secondary")).toBe("#FCF3F2");
    expect(result.properties.get("--brand-foreground")).toBe("#090706");
    expect(result.properties.get("--brand-surface")).toBe("#FCF3F2");
    expect(result.properties.get("--brand-primary")).toBe("#B0472B");
    // The class and the scheme attribute are what actually darken the page
    // before any token is read, so they are the flash itself, not a detail.
    expect(result.classes.has("dark")).toBe(false);
    expect(result.dataset["themeScheme"]).toBe("light");
    expect(result.document.documentElement.style.colorScheme).toBe("light");
    expect(result.themeColor.content).toBe("#FFFFFF");
    // The app background belongs to the brightness too — a light page under the
    // dark rendering's gradient is the same flash in a different layer.
    expect(result.properties.get("--bootstrap-app-background-image")).toContain(
      LIGHT_APP_GRADIENT,
    );
  });

  it("keeps the concept's dark rendering when that is what the subscriber chose", () => {
    const result = executeBootstrap(conceptSnapshot(), {
      entries: { [themeModeKey(CONCEPT_ID)]: "dark" },
    });

    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.properties.get("--brand-foreground")).toBe("#F8F5F1");
    expect(result.classes.has("dark")).toBe(true);
  });

  it("ignores a stored choice while the operator keeps the policy fixed", () => {
    const result = executeBootstrap(
      conceptSnapshot({ themeModePolicy: "fixed" }),
      { entries: { [themeModeKey(CONCEPT_ID)]: "light" } },
    );

    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.properties.get("--brand-foreground")).toBe("#F8F5F1");
    expect(result.classes.has("dark")).toBe(true);
  });

  it("still applies the variant of a fixed policy's own default brightness", () => {
    // A fixed policy is not "ignore the variants" — the runtime resolves the
    // operator's default mode through them just the same. Only the subscriber's
    // stored choice is out of play.
    const result = executeBootstrap(
      conceptSnapshot({ themeModePolicy: "fixed", themeDefaultMode: "light" }),
    );

    expect(result.properties.get("--brand-bg-primary")).toBe("#FFFFFF");
    expect(result.properties.get("--brand-foreground")).toBe("#090706");
    expect(result.classes.has("dark")).toBe(false);
  });

  it("falls back to the operator default when nothing is stored", () => {
    const result = executeBootstrap(conceptSnapshot());

    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.classes.has("dark")).toBe(true);
  });

  it("drops a choice recorded against a superseded preset version", () => {
    // Raising the preset version resets every subscriber's choice, because the
    // key is derived from the version. The pre-paint script must reset with it,
    // or it paints a brightness the app is about to abandon.
    const result = executeBootstrap(
      conceptSnapshot({ themePresetVersion: 4 }),
      { entries: { [themeModeKey(CONCEPT_ID, 1)]: "light" } },
    );

    expect(result.reads).toContain(themeModeKey(CONCEPT_ID, 4));
    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.classes.has("dark")).toBe(true);
  });

  it("honours a choice recorded against the current preset version", () => {
    const result = executeBootstrap(
      conceptSnapshot({ themePresetVersion: 4 }),
      { entries: { [themeModeKey(CONCEPT_ID, 4)]: "light" } },
    );

    expect(result.properties.get("--brand-bg-primary")).toBe("#FFFFFF");
  });

  it("reads version 1 for a snapshot that carries no preset version", () => {
    const result = executeBootstrap(
      conceptSnapshot({ themePresetVersion: null }),
      { entries: { [themeModeKey(CONCEPT_ID, 1)]: "light" } },
    );

    expect(result.reads).toContain(themeModeKey(CONCEPT_ID, 1));
    expect(result.properties.get("--brand-bg-primary")).toBe("#FFFFFF");
  });

  it("keeps a zero preset version verbatim rather than reading it as absent", () => {
    // `branding-provider.tsx` builds the key with `?? 1`, so only null and
    // undefined become 1. Writing `|| 1` here instead — which the preset-version
    // dataset attribute a few lines further down genuinely does — would send the
    // two sides to different keys and silently discard the choice.
    const result = executeBootstrap(
      conceptSnapshot({ themePresetVersion: 0 }),
      { entries: { [themeModeKey(CONCEPT_ID, 0)]: "light" } },
    );

    expect(result.reads).toContain(themeModeKey(CONCEPT_ID, 0));
    expect(result.properties.get("--brand-bg-primary")).toBe("#FFFFFF");
  });

  it("offers no brightness choice outside a concept preset", () => {
    // The runtime only builds a key for `concept-*`; an operator theme that is
    // not a concept has no second rendering to switch to.
    const result = executeBootstrap(
      conceptSnapshot({ themePresetId: "custom-house-style" }),
      { entries: { "reiwa_theme_mode:custom-house-style:1": "light" } },
    );

    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.classes.has("dark")).toBe(true);
  });

  it("keeps an operator's hand-picked palette in either brightness", () => {
    // `brandPaletteSource: "custom"` means the colours are the operator's, not
    // the concept's, and no variant may repaint them — palette AND surfaces,
    // because the two are one contrast decision.
    const result = executeBootstrap(
      conceptSnapshot({ brandPaletteSource: "custom" }),
      { entries: { [themeModeKey(CONCEPT_ID)]: "light" } },
    );

    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.properties.get("--brand-foreground")).toBe("#F8F5F1");
    // The app background is not part of that ownership rule; it still follows
    // the chosen brightness.
    expect(result.properties.get("--bootstrap-app-background-image")).toContain(
      LIGHT_APP_GRADIENT,
    );
  });

  it("keeps an operator's own card gradient in either brightness", () => {
    const operatorGradient = "linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)";
    const result = executeBootstrap(
      conceptSnapshot({
        cardGradientSource: "custom",
        cardGradient: operatorGradient,
      }),
      { entries: { [themeModeKey(CONCEPT_ID)]: "light" } },
    );

    expect(result.properties.get("--brand-card-gradient")).toBe(operatorGradient);
    expect(result.properties.get("--brand-bg-primary")).toBe("#FFFFFF");
  });

  it("keeps the geometry and typeface out of the brightness switch", () => {
    const result = executeBootstrap(
      conceptSnapshot({
        borderRadius: "rounded-none",
        cornerRadii: { cardPx: 2, itemPx: 1, pillPx: 0 },
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      }),
      { entries: { [themeModeKey(CONCEPT_ID)]: "light" } },
    );

    expect(result.properties.get("--radius-card")).toBe("2px");
    expect(result.properties.get("--radius-item")).toBe("1px");
    expect(result.properties.get("--radius-pill")).toBe("0px");
    expect(result.properties.get("--brand-font")).toBe(
      '"IBM Plex Mono", ui-monospace, monospace',
    );
  });

  it("paints the root palette unchanged when the snapshot predates variants", () => {
    const result = executeBootstrap(conceptSnapshot({ themeVariants: null }), {
      entries: { [themeModeKey(CONCEPT_ID)]: "light" },
    });

    expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
    expect(result.properties.get("--brand-foreground")).toBe("#F8F5F1");
    expect(result.classes.has("dark")).toBe(true);
  });
});

describe("pre-paint brightness survives unusable storage", () => {
  /**
   * Every case here is one the browser owner can produce by hand, and an
   * exception in any of them means the page paints with NO theme at all — the
   * failure this script exists to prevent, made worse.
   */
  const unusable: ReadonlyArray<readonly [string, BootstrapStorage]> = [
    ["a JSON document instead of a mode", { entries: { [themeModeKey(CONCEPT_ID)]: '{"mode":"light"}' } }],
    ["the right word in the wrong case", { entries: { [themeModeKey(CONCEPT_ID)]: "LIGHT" } }],
    ["an empty string", { entries: { [themeModeKey(CONCEPT_ID)]: "" } }],
    ["a truncated payload", { entries: { [themeModeKey(CONCEPT_ID)]: '{"mode":"lig' } }],
    ["a read that throws", { blocked: [themeModeKey(CONCEPT_ID)] }],
  ];

  for (const [name, storage] of unusable) {
    it(`falls back to the operator default for ${name}`, () => {
      const result = executeBootstrap(conceptSnapshot(), storage);

      expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
      expect(result.properties.get("--brand-foreground")).toBe("#F8F5F1");
      expect(result.classes.has("dark")).toBe(true);
    });
  }

  const corrupt: ReadonlyArray<readonly [string, unknown]> = [
    ["variants held as a string", "light-and-dark"],
    ["variants held as an array", []],
    ["a variant that is not an object", { light: "#ffffff", dark: "#000000" }],
    ["a variant with no palette at all", { light: {}, dark: {} }],
    ["a variant whose colours are not colours", {
      light: { ...LIGHT_VARIANT, bgPrimary: "not-a-colour" },
      dark: DARK_VARIANT,
    }],
    ["a variant with no surfaces", {
      light: { ...LIGHT_VARIANT, surfaceTheme: null },
      dark: DARK_VARIANT,
    }],
    ["a variant whose surface opacity is a string", {
      light: {
        ...LIGHT_VARIANT,
        surfaceTheme: { ...LIGHT_SURFACE, surfaceOpacity: "0.9" },
      },
      dark: DARK_VARIANT,
    }],
  ];

  for (const [name, themeVariants] of corrupt) {
    it(`keeps the root palette whole for ${name}`, () => {
      const result = executeBootstrap(
        conceptSnapshot({ themeVariants: themeVariants as never }),
        { entries: { [themeModeKey(CONCEPT_ID)]: "light" } },
      );

      // The root palette and the root surfaces move together or not at all: a
      // half-applied variant is how a light background gets light text.
      expect(result.properties.get("--brand-bg-primary")).toBe("#090706");
      expect(result.properties.get("--brand-bg-secondary")).toBe("#171311");
      expect(result.properties.get("--brand-foreground")).toBe("#F8F5F1");
      expect(result.properties.get("--brand-surface")).toBe("#171311");
      expect(result.classes.has("dark")).toBe(true);
    });
  }

  it("never emits a non-colour token from a corrupt variant", () => {
    const result = executeBootstrap(
      conceptSnapshot({
        themeVariants: {
          light: { ...LIGHT_VARIANT, bgPrimary: "red; background: url(x)" },
          dark: DARK_VARIANT,
        } as never,
      }),
      { entries: { [themeModeKey(CONCEPT_ID)]: "light" } },
    );

    for (const value of result.properties.values()) {
      expect(value).not.toContain("url(x)");
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Parity — the pre-paint script and the runtime resolver must not drift.
 *
 * `resolveBrandingThemeMode` cannot be imported from `web/public/`: this file
 * is served verbatim and runs before any module loads. The duplication is
 * therefore deliberate, and this block is what keeps it honest — the same
 * snapshot through both paths, asserting they paint the same tokens.
 *
 * Only tokens BOTH sides set are compared. The pre-paint script additionally
 * validates everything it reads (a corrupt variant leaves the root palette
 * whole rather than painting garbage) and owns the `--bootstrap-app-background-*`
 * handoff, neither of which the runtime has any counterpart for.
 * ------------------------------------------------------------------------- */

/** Painting none of these would let the comparison below pass vacuously. */
const REQUIRED_PARITY_TOKENS = [
  "--brand-primary",
  "--brand-primary-fg",
  "--brand-bg-primary",
  "--brand-bg-secondary",
  "--brand-font",
  "--brand-foreground",
  "--brand-surface",
  "--color-surface",
  "--radius-card",
] as const;

function applyRuntimeTheme(branding: Branding, mode: BrandingThemeMode) {
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
  try {
    applyBrandingToDocument(resolveBrandingThemeMode(branding, mode));
  } finally {
    vi.unstubAllGlobals();
  }
  return { classes, dataset, properties, style };
}

function expectBrightnessParity(
  branding: Branding,
  mode: BrandingThemeMode,
  storage: BootstrapStorage = {},
): void {
  const bootstrap = executeBootstrap(
    { ...DEFAULT_PUBLIC_CONFIG, branding },
    storage,
  );
  const runtime = applyRuntimeTheme(branding, mode);

  for (const token of REQUIRED_PARITY_TOKENS) {
    expect(bootstrap.properties.has(token), `pre-paint skipped ${token}`).toBe(
      true,
    );
  }
  for (const [token, value] of bootstrap.properties) {
    if (!runtime.properties.has(token)) continue;
    expect(value, `pre-paint and runtime disagree on ${token}`).toBe(
      runtime.properties.get(token),
    );
  }
  expect(bootstrap.classes.has("dark")).toBe(runtime.classes.has("dark"));
  expect(bootstrap.document.documentElement.style.colorScheme).toBe(
    runtime.style.colorScheme,
  );
  expect(bootstrap.dataset["themeScheme"]).toBe(runtime.dataset["themeScheme"]);
  expect(bootstrap.dataset["themePreset"]).toBe(runtime.dataset["themePreset"]);
  expect(bootstrap.dataset["themePresetVersion"]).toBe(
    runtime.dataset["themePresetVersion"],
  );
}

describe("pre-paint brightness parity with resolveBrandingThemeMode", () => {
  const chose = (mode: BrandingThemeMode): BootstrapStorage => ({
    entries: { [themeModeKey(CONCEPT_ID)]: mode },
  });

  it("agrees on the light rendering the subscriber chose", () => {
    expectBrightnessParity(conceptBranding(), "light", chose("light"));
  });

  it("agrees on the dark rendering the subscriber chose", () => {
    expectBrightnessParity(conceptBranding(), "dark", chose("dark"));
  });

  it("agrees on the operator default when nothing is stored", () => {
    expectBrightnessParity(conceptBranding(), "dark");
  });

  it("agrees on a fixed policy's light default", () => {
    expectBrightnessParity(
      conceptBranding({ themeModePolicy: "fixed", themeDefaultMode: "light" }),
      "light",
    );
  });

  it("agrees that a fixed policy discards a stored choice", () => {
    expectBrightnessParity(
      conceptBranding({ themeModePolicy: "fixed" }),
      "dark",
      chose("light"),
    );
  });

  it("agrees that a superseded version discards a stored choice", () => {
    expectBrightnessParity(
      conceptBranding({ themePresetVersion: 7 }),
      "dark",
      { entries: { [themeModeKey(CONCEPT_ID, 1)]: "light" } },
    );
  });

  it("agrees on an operator's hand-picked palette", () => {
    expectBrightnessParity(
      conceptBranding({
        brandPaletteSource: "custom",
        primary: "#3B82F6",
        primaryFg: "#FFFFFF",
        bgPrimary: "#0B1220",
        bgSecondary: "#111C2E",
      }),
      "light",
      chose("light"),
    );
  });

  it("agrees on an operator's own card gradient", () => {
    expectBrightnessParity(
      conceptBranding({
        cardGradientSource: "custom",
        cardGradient: "linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)",
      }),
      "light",
      chose("light"),
    );
  });

  it("agrees on a custom palette in a snapshot that predates surfaces", () => {
    // `surfaceTheme` is optional on the root and required on a variant, so the
    // runtime falls back to the variant's surfaces here even though the palette
    // is the operator's. The pre-paint script has to make the same call.
    const { surfaceTheme: _surfaceTheme, ...withoutSurfaces } = conceptBranding({
      brandPaletteSource: "custom",
    });

    expectBrightnessParity(withoutSurfaces as Branding, "light", chose("light"));
  });

  it("agrees on a legacy snapshot with no variants at all", () => {
    expectBrightnessParity(
      conceptBranding({ themeVariants: null }),
      "dark",
      chose("light"),
    );
  });
});
