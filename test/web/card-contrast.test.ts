import { describe, expect, it } from "vitest";

import {
  ensureReadableCardAccent,
  resolveCardContrast,
  type CardContrast,
} from "../../web/src/lib/card-contrast.js";
import {
  resolveCardEffectOutputColors,
} from "../../web/src/components/reactbits/card-effect-runtime.js";
import {
  autoPlanGradient,
  readablePriceColor,
  resolvePlanCardStyle,
} from "../../web/src/features/plans/plan-card-visual.js";
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
      channel * alpha + background[index] * (1 - alpha),
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

function expectStopsToPass(
  result: CardContrast,
  stops: readonly string[],
): void {
  const foreground = hexRgb(result.foreground);
  const veil = channelsRgb(result.veilRgb);
  for (const stop of stops) {
    const supported = composite(
      veil,
      hexRgb(stop),
      result.veilOpacity,
    );
    expect(ratio(foreground, supported)).toBeGreaterThanOrEqual(4.5);
  }
}

describe("artwork card contrast", () => {
  it("uses a dark foreground and light supporting veil for light presets", () => {
    const stops = ["#fffdf8", "#f4e7d3", "#d9c6aa"];
    const result = resolveCardContrast(
      `linear-gradient(135deg, ${stops.join(", ")})`,
      {
        fallbackBackground: "#fffdf8",
        preferredForeground: "#111111",
      },
    );

    expect(result.foregroundTone).toBe("dark");
    expect(result.foreground).toBe("#0a0a0a");
    expect(result.veilRgb).toBe("255 255 255");
    expectStopsToPass(result, stops);
  });

  it("uses a light foreground and dark supporting veil for dark presets", () => {
    const stops = ["#050816", "#11213b", "#1d3557"];
    const result = resolveCardContrast(
      `linear-gradient(135deg, ${stops.join(", ")})`,
      {
        fallbackBackground: "#050816",
        preferredForeground: "#ffffff",
      },
    );

    expect(result.foregroundTone).toBe("light");
    expect(result.foreground).toBe("#ffffff");
    expect(result.veilRgb).toBe("0 0 0");
    expectStopsToPass(result, stops);
  });

  it("chooses the cheaper black or white veil for a saturated custom foreground", () => {
    const result = resolveCardContrast(
      "linear-gradient(135deg, #ffffff, #f4f4f5)",
      {
        fallbackBackground: "#ffffff",
        forcedForeground: "#ff00ff",
      },
    );

    expect(result.foreground).toBe("#ff00ff");
    // Magenta has a dark luminance, but a white veil cannot improve its
    // contrast on this bright artwork. A black veil is the lower-cost path.
    expect(result.veilRgb).toBe("0 0 0");
  });

  it("raises the veil only as far as needed for mixed light/dark artwork", () => {
    const stops = ["#000000", "#ffffff", "#64748b"];
    const result = resolveCardContrast(
      `linear-gradient(90deg, ${stops.join(", ")})`,
      { preferredForeground: "#111111" },
    );

    expect(result.veilOpacity).toBeGreaterThan(0.4);
    expect(result.veilOpacity).toBeLessThanOrEqual(0.75);
    expectStopsToPass(result, stops);
  });

  it("includes the composited animated effect colours in the AA calculation", () => {
    const base = "#020617";
    const effect = "#e6ff58";
    const effectOpacity = 0.84;
    const result = resolveCardContrast(
      `linear-gradient(135deg, ${base}, #111827)`,
      {
        fallbackBackground: base,
        preferredForeground: "#ffffff",
        overlayArtwork: effect,
        overlayOpacity: effectOpacity,
      },
    );
    const animatedSample = composite(
      hexRgb(effect),
      hexRgb(base),
      effectOpacity,
    );
    const supported = composite(
      channelsRgb(result.veilRgb),
      animatedSample,
      result.veilOpacity,
    );

    expect(result.veilOpacity).toBeGreaterThan(0.12);
    expect(
      ratio(hexRgb(result.foreground), supported),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps text AA-safe when LineWaves amplifies dark inputs into bright yellow", () => {
    const base = "#000000";
    const shaderOutput = "#fff755";
    const effectOpacity = 0.84;
    const result = resolveCardContrast(
      "radial-gradient(ellipse 90% 58% at 64% 8%, #807158CC 0%, transparent 64%), linear-gradient(180deg, #2B2922 0%, #2B1E0A 54%, #000000 100%)",
      {
        fallbackBackground: "#F2ECDE",
        preferredForeground: "#ffffff",
        overlayArtwork: resolveCardEffectOutputColors("lineWaves", {
          color1: "#9A6A24",
          color2: "#553A15",
          color3: "#000000",
        }).join(" "),
        overlayOpacity: effectOpacity,
      },
    );
    const animatedSample = composite(
      hexRgb(shaderOutput),
      hexRgb(base),
      effectOpacity,
    );
    const supported = composite(
      channelsRgb(result.veilRgb),
      animatedSample,
      result.veilOpacity,
    );

    expect(result.foregroundTone).toBe("dark");
    expect(
      ratio(hexRgb(result.foreground), supported),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    {
      name: "dark foreground over an additive black extreme",
      gradient:
        "radial-gradient(ellipse 90% 58% at 88% 8%, #F29B84CC 0%, transparent 64%), linear-gradient(180deg, #0B5E5A 0%, #165251 54%, #163B3B 100%)",
      fallback: "#F1FAF8",
      preferredForeground: "#000000",
      effect: "lineWaves",
      effectProps: {
        color1: "#158C88",
        color2: "#0B5E5A",
        color3: "#000000",
      },
      effectOpacity: 0.84,
      base: "#163B3B",
      shaderExtreme: "#000000",
      foregroundTone: "dark",
    },
    {
      name: "light foreground over an amplified white extreme",
      gradient:
        "linear-gradient(170deg, #03080B 0 44%, #204B54 44% 67%, #04111A 67% 100%)",
      fallback: "#04111A",
      preferredForeground: "#000000",
      effect: "rippleGrid",
      effectProps: { gridColor: "#65E6FF" },
      effectOpacity: 0.68,
      base: "#204B54",
      shaderExtreme: "#ffffff",
      foregroundTone: "light",
    },
  ])(
    "keeps the profile copy AA-safe with local support: $name",
    ({
      gradient,
      fallback,
      preferredForeground,
      effect,
      effectProps,
      effectOpacity,
      base,
      shaderExtreme,
      foregroundTone,
    }) => {
      const result = resolveCardContrast(gradient, {
        fallbackBackground: fallback,
        preferredForeground,
        overlayArtwork: resolveCardEffectOutputColors(
          effect,
          effectProps,
        ).join(" "),
        overlayOpacity: effectOpacity,
      });
      const shaderSample = composite(
        hexRgb(shaderExtreme),
        hexRgb(base),
        effectOpacity,
      );
      const veil = channelsRgb(result.veilRgb);
      const artworkWindow = Math.max(
        0.035,
        result.veilOpacity * 0.28,
      );
      const globallySupported = composite(
        veil,
        shaderSample,
        artworkWindow,
      );
      const locallySupported = composite(
        veil,
        globallySupported,
        result.veilOpacity,
      );

      expect(result.foregroundTone).toBe(foregroundTone);
      expect(
        ratio(hexRgb(result.foreground), globallySupported),
      ).toBeLessThan(4.5);
      expect(
        ratio(hexRgb(result.foreground), locallySupported),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("understands the modern HSL syntax used by automatic tariff gradients", () => {
    const result = resolveCardContrast(autoPlanGradient("starter"));
    expect(result.foregroundTone).toBe("light");
    expect(result.foreground).toBe("#ffffff");
  });

  it("moves an unreadable accent toward the selected foreground until AA", () => {
    const background = "#f4f4f5";
    const adjusted = ensureReadableCardAccent(
      "#facc15",
      background,
      "#0a0a0a",
    );

    expect(ratio(hexRgb(adjusted), hexRgb(background))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      ratio(
        hexRgb(
          readablePriceColor("#2563eb", "#101827", "#ffffff"),
        ),
        hexRgb("#101827"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("tariff card visual contrast", () => {
  it("resolves configured light and automatic dark tariff artwork independently", () => {
    const light = resolvePlanCardStyle(
      "light",
      branding({
        primaryFg: "#0a0a0a",
        bgSecondary: "#f8fafc",
        planCardStyles: {
          light: {
            gradient:
              "linear-gradient(135deg, #fff7ed, #fde68a, #f8fafc)",
            accent: "#f59e0b",
            cardEffect: "aurora",
            cardEffectOpacity: 1,
          },
        },
      }),
    );
    const dark = resolvePlanCardStyle("automatic-dark", branding());

    expect(light.contrast.foregroundTone).toBe("dark");
    expect(dark.contrast.foregroundTone).toBe("light");
    expect(light.contrast.veilOpacity).toBeGreaterThanOrEqual(0.3);
    expect(light.contrast.overlayBackground).toContain("255 255 255");
    expect(dark.contrast.overlayBackground).toContain("0 0 0");
  });
});
