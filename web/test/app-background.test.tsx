import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Branding } from "../src/types/branding";

const brandingContext = vi.hoisted(() => ({
  branding: null as Branding | null,
}));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: brandingContext.branding }),
}));

import { AppBackground } from "../src/components/layout/app-background";
import { DEFAULT_BRANDING } from "../src/types/branding";
import { resolveAppBackgroundReadability } from "../src/lib/app-background-contrast";

function renderBackground(overrides: Partial<Branding>): string {
  brandingContext.branding = {
    ...DEFAULT_BRANDING,
    ...overrides,
    appBackground: {
      ...DEFAULT_BRANDING.appBackground!,
      ...overrides.appBackground,
      texture: {
        ...DEFAULT_BRANDING.appBackground!.texture,
        ...overrides.appBackground?.texture,
      },
    },
  };
  return renderToStaticMarkup(<AppBackground />);
}

describe("AppBackground concept contract", () => {
  afterEach(() => {
    brandingContext.branding = null;
  });

  it("renders the concept texture over its exact gradient base", () => {
    const gradient =
      "linear-gradient(90deg, #edf5f7 0 42%, #c7dbe1 42% 68%, #d6bfc4 68% 86%, #fffdfb 86%)";
    const markup = renderBackground({
      themePresetId: "concept-cu",
      themePresetVersion: 1,
      appBackground: {
        ...DEFAULT_BRANDING.appBackground!,
        kind: "gradient",
        gradient,
        texture: {
          pattern: "grid",
          color: "#ef4444",
          background: "#edf5f7",
          scale: 32,
          opacity: 0.16,
        },
      },
    });

    expect(markup).toContain('data-app-background-kind="gradient"');
    expect(markup).toContain(
      'data-app-background-concept-texture="grid"',
    );
    expect(markup).toContain("background:linear-gradient(90deg");
    expect(markup).toContain("background-image:url(&quot;data:image/svg+xml");
    expect(markup).toContain("background-size:32px 32px");
  });

  it("adds a neutral readability veil for washed-out direct shell copy zones", () => {
    const branding = {
      ...DEFAULT_BRANDING,
      themePresetId: "concept-am",
      themePresetVersion: 1,
      appBackground: {
        ...DEFAULT_BRANDING.appBackground!,
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
        ...DEFAULT_BRANDING.surfaceTheme!,
        foreground: "#FFF7EF",
        mutedForeground: "#D6B7AD",
      },
    } satisfies Branding;
    brandingContext.branding = branding;

    const readability = resolveAppBackgroundReadability(branding);
    const markup = renderToStaticMarkup(<AppBackground />);

    expect(readability).not.toBeNull();
    expect(readability?.veilRgb).toBe("0 0 0");
    expect(readability?.veilOpacity).toBeGreaterThan(0.6);
    expect(markup).toContain(
      'data-app-background-readability="wcag-direct-copy-zones"',
    );
    expect(markup).toContain(
      `data-app-background-readability-opacity="${readability?.veilOpacity}"`,
    );
    expect(markup).toContain("rgb(0 0 0 /");
  });

  it("does not invent a texture for an operator-authored legacy gradient", () => {
    const markup = renderBackground({
      themePresetId: null,
      appBackground: {
        ...DEFAULT_BRANDING.appBackground!,
        kind: "gradient",
        gradient: "linear-gradient(135deg, #101820, #263747)",
        texture: {
          pattern: "noise",
          color: "#ffffff",
          background: "#101820",
          scale: 40,
          opacity: 0.2,
        },
      },
    });

    expect(markup).toContain('data-app-background-kind="gradient"');
    expect(markup).not.toContain(
      "data-app-background-concept-texture",
    );
  });

  it("keeps an accepted legacy concept gradient without texture mount-safe", () => {
    brandingContext.branding = {
      ...DEFAULT_BRANDING,
      themePresetId: "concept-legacy",
      themePresetVersion: 1,
      appBackground: {
        kind: "gradient",
        effect: "NONE",
        props: {},
        opacity: 1,
        gradient: "linear-gradient(135deg, #101820, #263747)",
      },
    } as Branding;

    expect(() => renderToStaticMarkup(<AppBackground />)).not.toThrow();
    const markup = renderToStaticMarkup(<AppBackground />);
    expect(markup).toContain('data-app-background-kind="gradient"');
    expect(markup).not.toContain(
      "data-app-background-concept-texture",
    );
  });
});
