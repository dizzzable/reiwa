import { describe, expect, it } from "vitest";

import { resolveAppBackgroundReadability } from "../../web/src/lib/app-background-contrast.js";
import {
  DEFAULT_BRANDING,
  type Branding,
} from "../../web/src/types/branding.js";

type Rgb = readonly [number, number, number];

function branding(overrides: Partial<Branding> = {}): Branding {
  return {
    ...DEFAULT_BRANDING,
    cardEffectProps: { ...DEFAULT_BRANDING.cardEffectProps },
    cardEffectsByIndex: [...DEFAULT_BRANDING.cardEffectsByIndex],
    planCardStyles: { ...DEFAULT_BRANDING.planCardStyles },
    ...overrides,
  };
}

function hexRgb(value: string): Rgb {
  const body = value.replace(/^#/, "");
  const expanded =
    body.length === 3
      ? body
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : body.slice(0, 6);
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function channelsRgb(value: string): Rgb {
  const channels = value.split(/\s+/).map(Number);
  return [channels[0]!, channels[1]!, channels[2]!];
}

function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) =>
      Math.round(channel * alpha + background[index] * (1 - alpha)),
  ) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(left: Rgb, right: Rgb): number {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function weakestZoneOpacity(background: string): number {
  const opacities = [...background.matchAll(/\/\s*([0-9.]+)\)/g)].map(
    (match) => Number.parseFloat(match[1]!),
  );
  return Math.min(...opacities);
}

describe("app background readability", () => {
  it("darkens AM direct-copy zones until both foreground tokens clear AA", () => {
    const sample = branding({
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
    });

    const result = resolveAppBackgroundReadability(sample);

    expect(result).not.toBeNull();
    expect(result?.veilRgb).toBe("0 0 0");
    expect(result?.veilOpacity).toBeGreaterThan(0.6);

    const supportedWeakestZone = composite(
      channelsRgb(result!.veilRgb),
      hexRgb("#DFA98B"),
      weakestZoneOpacity(result!.overlayBackground),
    );

    expect(ratio(hexRgb("#FFF7EF"), supportedWeakestZone)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hexRgb("#D6B7AD"), supportedWeakestZone)).toBeGreaterThanOrEqual(4.5);
  });

  it("supports medium-muted light-on-dark tokens instead of dropping them by luminance", () => {
    const sample = branding({
      themePresetId: "concept-a",
      themePresetVersion: 1,
      appBackground: {
        ...DEFAULT_BRANDING.appBackground!,
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
        ...DEFAULT_BRANDING.surfaceTheme!,
        foreground: "#E8D5CB",
        mutedForeground: "#8A807B",
      },
    });

    const result = resolveAppBackgroundReadability(sample);

    expect(result).not.toBeNull();
    expect(result?.veilRgb).toBe("0 0 0");

    const supportedWeakestZone = composite(
      channelsRgb(result!.veilRgb),
      hexRgb("#351411"),
      weakestZoneOpacity(result!.overlayBackground),
    );

    expect(ratio(hexRgb("#E8D5CB"), supportedWeakestZone)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hexRgb("#8A807B"), supportedWeakestZone)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * ONE opacity from the top of the shell to the bottom.
   *
   * This value used to be a `linear-gradient(180deg, …)` carrying
   * `veilOpacity + 0.12` at its 0% and 100% stops. The element that receives it
   * is `absolute inset-0` over the whole `100dvh` shell (`app-background.tsx`),
   * so the bottom ramp painted the bottom 16% of the VIEWPORT — about 130px on
   * a phone — darker than the rest of the page and full-bleed across it. That
   * is exactly where the floating bottom-nav pill sits, and the pill is
   * `w-fit`, so it read as a skirt around the pill sticking out to its left and
   * right. 101 of the 104 concept presets resolve to a veil, so operators saw it
   * on effectively every concept theme, and the panel's branding preview
   * reproduced it by rendering this same string.
   *
   * A stop position reappearing in this value is that band reappearing.
   */
  it("paints one opacity edge to edge, so nothing bands behind the bottom nav", () => {
    const result = resolveAppBackgroundReadability(
      branding({
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
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.overlayBackground).toBe(
      `rgb(${result!.veilRgb} / ${result!.veilOpacity})`,
    );
    expect(result!.overlayBackground).not.toMatch(/\d+%/);
  });

  it("stays out of already-readable dark shells", () => {
    const result = resolveAppBackgroundReadability(
      branding({
        appBackground: {
          ...DEFAULT_BRANDING.appBackground!,
          kind: "gradient",
          gradient: "linear-gradient(180deg, #080B14 0%, #111827 100%)",
        },
      }),
    );

    expect(result).toBeNull();
  });
});
