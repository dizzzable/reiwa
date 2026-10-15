// @vitest-environment jsdom

/**
 * «Способы оплаты» lists Antilopay's automatic charging with the way it charges
 * and where its plan of charges ends.
 *
 * A card autopay reads «с карты» and carries the card mark, an SBP one reads
 * «через СБП» and carries the SBP mark; and when Antilopay names an end to the
 * plan of charges (`end_date`, the number of charges set in the panel), the
 * card says so beside the next charge — the place the customer already looks
 * for the next date.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getPaymentMethods: vi.fn() }));
const marks = vi.hoisted(() => [] as Array<{ type: string; method: unknown }>);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()] as const,
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, initial: _i, animate: _a, transition: _t, ...props }: ComponentProps<"div"> & Record<string, unknown>) => (
      <div {...(props as ComponentProps<"div">)}>{children}</div>
    ),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({
  getPaymentMethods: api.getPaymentMethods,
  setPaymentMethodAutopay: vi.fn(),
  unbindPaymentMethod: vi.fn(),
  cancelProviderSubscription: vi.fn(),
  getPaymentMethodSetupStatus: vi.fn(),
  startPaymentMethodSetup: vi.fn(),
}));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/ui/gateway-icon", () => ({
  AutopayGatewayMark: ({ type, method }: { type: string; method?: unknown }) => {
    marks.push({ type, method });
    return null;
  },
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/components/ui/stadium-button", () => ({
  StadiumButton: ({ children, variant: _v, ...props }: ComponentProps<"button"> & { readonly variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import PaymentMethodsPage from "../src/features/settings/payment-methods-page";

const SUBSCRIPTION = {
  id: "ps-1",
  gatewayType: "ANTILOPAY",
  status: "ACTIVE" as const,
  amount: "299",
  currency: "RUB",
  intervalUnit: "month",
  intervalCount: 1,
  durationDays: 30,
  planName: "Pro",
  subscriptionId: "sub-1",
  nextChargeAt: null,
  lastChargeAt: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  marks.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(providerSubscriptions: unknown[]): Promise<string> {
  api.getPaymentMethods.mockResolvedValue({ methods: [], total: 0, providerSubscriptions });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PaymentMethodsPage />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  return container.textContent ?? "";
}

describe("«Способы оплаты» and Antilopay's automatic charging", () => {
  it("says a card autopay charges the card, and marks it with the card", async () => {
    const shown = await render([{ ...SUBSCRIPTION, method: "CARD" }]);

    expect(shown).toContain("paymentMethods.providerSubscriptions.viaCard");
    expect(marks).toEqual([{ type: "ANTILOPAY", method: "CARD" }]);
  });

  it("says an AuraPay autopay charges the card, though the panel names no method for it", async () => {
    const shown = await render([{ ...SUBSCRIPTION, gatewayType: "AURAPAY", method: null }]);

    expect(shown).toContain("paymentMethods.providerSubscriptions.viaCard");
  });

  it("says an SBP autopay goes over SBP, and marks it with SBP", async () => {
    const shown = await render([{ ...SUBSCRIPTION, method: "SBP" }]);

    expect(shown).toContain("paymentMethods.providerSubscriptions.via");
    expect(shown).not.toContain("paymentMethods.providerSubscriptions.viaCard");
    expect(marks).toEqual([{ type: "ANTILOPAY", method: "SBP" }]);
  });

  it("shows where the plan of charges ends, beside the next charge", async () => {
    const shown = await render([
      { ...SUBSCRIPTION, method: "CARD", nextChargeAt: "2026-10-01T00:00:00.000Z", endsAt: "2027-08-01T00:00:00.000Z" },
    ]);

    expect(shown).toContain("paymentMethods.providerSubscriptions.nextCharge");
    expect(shown).toContain("paymentMethods.providerSubscriptions.ends");
  });

  it("says nothing of an end when Antilopay names none, and an older panel's row reads as before", async () => {
    const shown = await render([
      { ...SUBSCRIPTION, method: "CARD", endsAt: null },
      { ...SUBSCRIPTION, id: "ps-2", gatewayType: "PLATEGA" },
    ]);

    expect(shown).not.toContain("paymentMethods.providerSubscriptions.ends");
    expect(marks).toEqual([
      { type: "ANTILOPAY", method: "CARD" },
      { type: "PLATEGA", method: undefined },
    ]);
  });
});
