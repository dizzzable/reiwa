import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

describe("SubscriptionCardFrame visual containment", () => {
  it("clips every artwork layer to one isolated card paint boundary", () => {
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
    expect(markup).toContain(
      "isolation:isolate;overflow:hidden;contain:paint",
    );

    const gradient = markup.indexOf(
      'data-subscription-card-layer="gradient"',
    );
    const effect = markup.indexOf('data-card-effect-source="aurora"');
    const pattern = markup.indexOf(
      'data-subscription-card-layer="pattern"',
    );
    const vignette = markup.indexOf(
      'data-subscription-card-layer="vignette"',
    );
    const copy = markup.indexOf("data-card-copy");

    expect(gradient).toBeGreaterThan(-1);
    expect(pattern).toBeGreaterThan(gradient);
    expect(effect).toBeGreaterThan(pattern);
    expect(vignette).toBe(-1);
    expect(copy).toBeGreaterThan(effect);
    expect(markup).not.toContain(
      'data-subscription-card-readability="wcag-copy-zones"',
    );
  });

  it("keeps the computed veil for a static card", () => {
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardEffect: "NONE",
      cardGradient: "linear-gradient(135deg, #ffffff, #e2e8f0)",
    });
    const markup = renderToStaticMarkup(
      <SubscriptionCardFrame visual={visual}>
        <span data-card-copy>Subscription</span>
      </SubscriptionCardFrame>,
    );

    expect(markup).toContain(
      'data-subscription-card-readability="wcag-copy-zones"',
    );
    expect(markup).toContain(
      `rgb(${visual.contrast.veilRgb} / ${visual.contrast.veilOpacity}) 41%`,
    );
  });

  it("uses compact opaque readability supports for vivid artwork", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionCardContent
        localReadability
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

    expect(markup).toContain("data-subscription-card-profile-support");
    expect(markup).toContain(
      "background-color:var(--card-support-background)",
    );
    expect(markup).toContain(
      'data-subscription-card-local-support="plan"',
    );
    expect(markup).toContain(
      'data-subscription-card-local-support="expiry"',
    );
  });

  it("builds an opaque effect-owned palette beneath the lazy renderer", () => {
    const markup = renderToStaticMarkup(
      <CardEffectLayer
        effect="waves"
        props={{ lineColor: "#7300ff", backgroundColor: "#000000" }}
        opacity={0.68}
        active
      />,
    );

    expect(markup).toContain("data-card-effect-palette-surface");
    expect(markup).toContain("data-card-effect-artwork");
    expect(markup).toContain("background-color:#7300ff");
    expect(markup).toContain("opacity:0.68");
    expect(markup).toContain('data-card-effect-ready="false"');
  });
});
