/**
 * «Главная»: a subscription with no end and no traffic cap reads «∞», not words.
 *
 * The owner, 31.10.2026, on a lifetime unlimited card: «БЕЗЛИМИТНЫЙ ТРАФИК» and
 * «ИСТЕКАЕТ —» → the infinity sign. The words stay for a screen reader; a date
 * that is merely unreadable keeps its «—», because that is not «never».
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operator-time-zone", () => ({ useOperatorTimeZone: () => undefined }));
vi.mock("@/lib/branding-provider", async () => {
  const { DEFAULT_BRANDING } = await import("../src/types/branding");
  return { useBranding: () => ({ branding: DEFAULT_BRANDING, customIcons: [] }) };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SubscriptionCardContent } from "../src/features/dashboard/components/subscription-card";
import type { Subscription } from "../src/types/api";

function subscription(fields: Record<string, unknown>): Subscription {
  return {
    id: "cmsub0001abcdefghijklmno",
    status: "ACTIVE",
    trafficUsed: 10,
    deviceLimit: 3,
    plan: { name: "Unlimited" },
    ...fields,
  } as unknown as Subscription;
}

describe("«Главная»: the card of a lifetime unlimited subscription", () => {
  it("shows «Трафик ∞» and «Истекает ∞», with the words only for a screen reader", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionCardContent subscription={subscription({ expiresAt: null, trafficLimit: null })} />,
    );
    expect(markup).toContain("data-card-traffic-unlimited");
    expect(markup).toContain("card.traffic<");
    expect(markup).toContain('<span class="sr-only">card.trafficUnlimited</span>');
    expect(markup).toContain("data-card-lifetime");
    expect(markup).toContain('<span class="sr-only">card.noEnd</span>');
    expect(markup).toContain("card.expiresOn");
    expect(markup).not.toContain("—");
  });

  it("control: a date it cannot read is not «never» — it keeps «—»", () => {
    // `expiresAt` absent rather than `null`: the payload says nothing about the end.
    const markup = renderToStaticMarkup(<SubscriptionCardContent subscription={subscription({ trafficLimit: null })} />);
    expect(markup).not.toContain("data-card-lifetime");
    expect(markup).toContain("—");
  });

  it("control: a capped subscription with a date shows its bar and its end, no ∞", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionCardContent subscription={subscription({ expiresAt: "2030-01-01T00:00:00Z", trafficLimit: 100 })} />,
    );
    expect(markup).not.toContain("data-card-traffic-unlimited");
    expect(markup).not.toContain("data-card-lifetime");
    expect(markup).toContain("card.trafficUsed");
    expect(markup).toContain("card.remaining");
  });
});
