import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CardEffect } from "../src/types/branding";

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ customIcons: [] }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SubscriptionCardFrame } from "../src/features/dashboard/components/subscription-card-frame";
import { SubscriptionCardContent } from "../src/features/dashboard/components/subscription-card";
import { resolveSubscriptionCardVisual } from "../src/features/dashboard/components/subscription-card-visual";
import { CardEffectLayer } from "../src/components/reactbits/card-effect-layer";
import { DEFAULT_BRANDING } from "../src/types/branding";

function fullHeightGradientOpacities(markup: string): readonly [number, number] {
  const stops = new Map<number, number>();
  for (const match of markup.matchAll(
    /rgb\([\d.]+ [\d.]+ [\d.]+ \/ ([\d.]+)\) (0|100)%/g,
  )) {
    stops.set(Number(match[2]), Number(match[1]));
  }
  const start = stops.get(0);
  const end = stops.get(100);
  if (start === undefined || end === undefined) {
    throw new Error("Expected a generated full-height readability gradient");
  }
  return [start, end];
}

describe("SubscriptionCardFrame visual containment", () => {
  it("keeps animated artwork above static layers with normal source-over compositing", () => {
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardGradient:
        "linear-gradient(135deg, #ff1744 0%, #651fff 48%, #00e5ff 100%)",
      cardPattern:
        "linear-gradient(#ffffff24 1px, transparent 1px), linear-gradient(90deg, #ffffff24 1px, transparent 1px)",
      cardEffect: "aurora",
      cardEffectProps: {
        colorStops: ["#ff1744", "#651fff", "#00e5ff"],
      },
      cardEffectOpacity: 0.84,
    });

    const markup = renderToStaticMarkup(
      <SubscriptionCardFrame visual={visual} effectActive={false}>
        <span data-card-copy>Subscription</span>
      </SubscriptionCardFrame>,
    );

    expect(markup).toContain("relative isolate");
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain("[contain:paint]");
    expect(markup).toContain('data-card-effect-source="aurora"');
    expect(markup).toContain("overflow:hidden");
    expect(markup).not.toContain("mix-blend-mode");
    expect(markup).not.toContain("isolation:isolate;overflow:hidden");

    const gradient = markup.indexOf(
      'data-subscription-card-layer="gradient"',
    );
    const effect = markup.indexOf('data-card-effect-source="aurora"');
    const pattern = markup.indexOf(
      'data-subscription-card-layer="pattern"',
    );
    const copy = markup.indexOf("data-card-copy");

    expect(gradient).toBeGreaterThan(-1);
    expect(pattern).toBeGreaterThan(gradient);
    expect(effect).toBeGreaterThan(pattern);
    expect(copy).toBeGreaterThan(effect);
    expect(markup).toContain('data-subscription-card-artwork="animated"');
    // Nothing is painted between the shader and the copy.
    expect(markup).not.toContain('data-subscription-card-layer="vignette"');
    expect(markup).not.toContain("data-subscription-card-readability");
    expect(markup).not.toContain("text-shadow");
  });

  it("renders opt-in glass above, but independently from, live artwork", () => {
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardEffect: "paperWarp",
      cardEffectProps: { colors: ["#050505", "#7c3aed", "#22d3ee"] },
      cardEffectOpacity: 0.72,
      subscriptionCardGlass: {
        enabled: true,
        tint: "#ffffff",
        opacity: 0.16,
        blurPx: 10,
        borderOpacity: 0.24,
      },
    });

    const markup = renderToStaticMarkup(
      <SubscriptionCardFrame visual={visual} effectActive>
        <span data-card-copy>Subscription</span>
      </SubscriptionCardFrame>,
    );

    const effect = markup.indexOf('data-card-effect-source="paperWarp"');
    const glass = markup.indexOf('data-subscription-card-layer="glass"');
    const copy = markup.indexOf("data-card-copy");
    expect(effect).toBeGreaterThan(-1);
    expect(glass).toBeGreaterThan(effect);
    expect(copy).toBeGreaterThan(glass);
    expect(markup).toContain("background-color:rgb(255 255 255 / 0.16)");
    expect(markup).toContain("border:1px solid rgb(255 255 255 / 0.24)");
    expect(markup).toContain("backdrop-filter:blur(10px)");
    expect(markup).toContain("-webkit-backdrop-filter:blur(10px)");
    // Glass must not change the effect source, palette, or selected opacity.
    expect(markup).toContain('data-card-effect-source="paperWarp"');
    expect(visual.cardEffectOpacity).toBe(0.72);
  });

  it("leaves a static operator gradient unchanged by automatic readability film", () => {
    const stops = ["#ffffff", "#e2e8f0"] as const;
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardEffect: "NONE",
      cardGradient: `linear-gradient(135deg, ${stops.join(", ")})`,
    });
    const markup = renderToStaticMarkup(
      <SubscriptionCardFrame visual={visual}>
        <span data-card-copy>Subscription</span>
      </SubscriptionCardFrame>,
    );

    expect(markup).toContain('data-subscription-card-artwork="static"');
    expect(markup).toContain(
      'data-subscription-card-layer="gradient"',
    );
    expect(markup).toContain(stops[0]);
    expect(markup).toContain(stops[1]);
    expect(markup).not.toContain('data-subscription-card-layer="vignette"');
    expect(markup).not.toContain("data-subscription-card-readability");
    expect(markup).not.toContain("text-shadow");
    expect(markup).toContain(`--card-foreground:${visual.contrast.foreground}`);
  });

  it("keeps vivid artwork copy clean without per-field capsules", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionCardContent
        subscription={{
          id: "sub-profile-support",
          userRemnaId: "usr_fallback",
          profileName: "usr_profile",
          status: "ACTIVE",
          isTrial: false,
          trafficLimit: null,
          trafficUsed: null,
          deviceLimit: null,
          expiresAt: "2030-01-01T00:00:00.000Z",
          url: null,
          plan: {
            id: "plan",
            name: "Unlimited",
            type: "PAID",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain("Unlimited");
    expect(markup).toContain("usr_profile");
    expect(markup).not.toContain("data-subscription-card-local-support");
    expect(markup).not.toContain("data-subscription-card-profile-support");
    expect(markup).not.toContain("--card-support-background");
  });

  it.each([
    {
      effect: "lineWaves",
      props: { color1: "#000000", color2: "#ffffff", color3: "#000000" },
    },
    {
      effect: "rippleGrid",
      props: { gridColor: "#ffffff", glowIntensity: 0.8 },
    },
  ] satisfies ReadonlyArray<{
    effect: CardEffect;
    props: Record<string, unknown>;
  }>)(
    "never films or outlines the copy over live $effect artwork",
    ({ effect, props }) => {
      const visual = resolveSubscriptionCardVisual({
        ...DEFAULT_BRANDING,
        cardEffect: effect,
        cardEffectProps: props,
        cardEffectOpacity: 1,
      });

      const markup = renderToStaticMarkup(
        <SubscriptionCardFrame visual={visual} effectActive />,
      );

      expect(markup).toContain('data-subscription-card-artwork="animated"');
      expect(markup).not.toContain('data-subscription-card-layer="vignette"');
      expect(markup).not.toContain("data-subscription-card-readability");
      expect(markup).not.toContain("text-shadow");
      expect(markup).not.toContain("-webkit-text-stroke");
      expect(markup).not.toContain("paint-order");
      // Readability now rests entirely on the tone the contrast resolver
      // picked from the composited shader output palette.
      expect(markup).toContain(
        `--card-foreground:${visual.contrast.foreground}`,
      );
      expect(["#0a0a0a", "#ffffff"]).toContain(visual.contrast.foreground);
    },
  );

  it("keeps the creation reveal overlay for an animated card", () => {
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardEffect: "aurora",
      cardEffectProps: { colorStops: ["#ff1744", "#651fff", "#00e5ff"] },
    });

    const markup = renderToStaticMarkup(
      <SubscriptionCardFrame
        visual={visual}
        effectActive={false}
        layerOpacity={{ foundation: 1, gradient: 1, vignette: 1 }}
      />,
    );

    expect(markup).toContain(
      'data-subscription-card-readability="creation-overlay"',
    );
    for (const opacity of fullHeightGradientOpacities(markup)) {
      expect(opacity).toBeGreaterThanOrEqual(visual.contrast.veilOpacity);
    }
  });

  it("keeps the operator gradient/pattern foundation when a lazy effect mounts", () => {
    const markup = renderToStaticMarkup(
      <CardEffectLayer
        effect="waves"
        props={{ lineColor: "#7300ff", backgroundColor: "#000000" }}
        opacity={0.68}
        active
      />,
    );

    // Native effects do not inject a palette foundation at all. The selected
    // gradient/pattern below the layer remain the card's source of colour.
    expect(markup).not.toContain("data-card-effect-palette-surface");
    expect(markup).not.toContain("background-color:#7300ff");
    expect(markup).toContain("opacity:1");
    expect(markup).toContain('data-card-effect-ready="false"');
  });
});
