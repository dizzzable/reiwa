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
    expect(effect).toBeGreaterThan(gradient);
    expect(pattern).toBeGreaterThan(effect);
    expect(vignette).toBeGreaterThan(pattern);
    expect(copy).toBeGreaterThan(vignette);
    expect(markup).toContain(
      'data-subscription-card-readability="wcag-copy-zones"',
    );
    expect(markup).toContain(
      `rgb(${visual.contrast.veilRgb} / ${visual.contrast.veilOpacity}) 41%`,
    );
    expect(markup).toContain(
      `rgb(${visual.contrast.veilRgb} / ${visual.contrast.veilOpacity}) 82%`,
    );
  });

  it("puts the full computed veil only behind profile copy", () => {
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

    expect(markup).toContain("data-subscription-card-profile-support");
    expect(markup).toContain(
      "background-color:rgb(var(--card-veil-rgb) / var(--card-veil-opacity))",
    );
  });
});
