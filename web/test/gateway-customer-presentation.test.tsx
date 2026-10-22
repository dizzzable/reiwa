// @vitest-environment jsdom

/**
 * «Как шлюз видят клиенты» (panel 0.9.7.78): the operator's name for a gateway,
 * the line under it and their SVG icon, in the payment step.
 *
 * Operators asked for it on 22.10.2026: customers met «Platega» and «Wata» with
 * «RUB» under them, could not tell which takes a card or SBP, and were afraid
 * to press any. What holds it here:
 *
 *  - the operator's name, line and icon are what the row shows, and a gateway
 *    with none set looks exactly as before (the provider's name, the currency
 *    code, the provider's logo);
 *  - the operator's SVG reaches the page only as an `<img>` source — an SVG
 *    loaded as an image runs no script — and never as markup;
 *  - the chosen gateway carries the icon on, so the review shows it too.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("@/lib/api-client", () => api);

import { GatewayIcon } from "../src/components/ui/gateway-icon";
import { GatewayPicker } from "../src/features/purchase/components/gateway-picker";
import { customGatewayIconUrl, gatewayCaption } from "../src/lib/gateway-display";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ICON)}`;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mountPicker(onSelect: (gateway: unknown) => void = vi.fn()): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <GatewayPicker
          purchase={null}
          selectedGateway={null}
          selectedSavedPaymentMethodId={null}
          onSelect={onSelect}
          onSelectSaved={vi.fn()}
          autoSelect={false}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.getPaymentMethods.mockResolvedValue({ methods: [] });
  api.getEnabledGateways.mockResolvedValue([
    {
      type: "WATA",
      currency: "RUB",
      isActive: true,
      displayName: "Карта или СБП",
      displayDescription: "Любая карта РФ\nили QR-код СБП",
      displayIconSvg: ICON,
    },
    { type: "PLATEGA", currency: "RUB", isActive: true },
  ]);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the payment step, with the operator's own name, line and icon", () => {
  it("shows them on the gateway that has them, and the provider's own on the one that has none", async () => {
    const page = await mountPicker();
    const [wata, platega] = Array.from(page.querySelectorAll("button"));

    expect(wata?.textContent).toContain("Карта или СБП");
    expect(wata?.textContent).toContain("Любая карта РФ\nили QR-код СБП");
    expect(wata?.textContent).not.toContain("Wata");
    expect(wata?.textContent).not.toContain("RUB");
    expect(wata?.querySelector("img")?.getAttribute("src")).toBe(ICON_URL);

    expect(platega?.textContent).toContain("Platega");
    expect(platega?.textContent).toContain("RUB");
    expect(platega?.querySelector("img")?.getAttribute("src")).not.toBe(ICON_URL);
  });

  it("never puts the operator's SVG into the page as markup", async () => {
    const page = await mountPicker();
    expect(page.querySelector("svg path[d='M0 0h24v24H0z']")).toBeNull();
    expect(page.innerHTML).not.toContain("<path d=\"M0 0h24v24H0z\"");
  });

  it("carries the operator's name and icon on to the review", async () => {
    const onSelect = vi.fn();
    const page = await mountPicker(onSelect);
    act(() => {
      page.querySelector("button")?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "WATA", label: "Карта или СБП", iconSvg: ICON, currency: "RUB" }),
    );
  });
});

describe("the helpers behind it", () => {
  it("makes an image source of an SVG and of nothing else", () => {
    expect(customGatewayIconUrl(ICON)).toBe(ICON_URL);
    expect(customGatewayIconUrl(`  ${ICON}\n`)).toBe(ICON_URL);
    expect(customGatewayIconUrl(null)).toBeNull();
    expect(customGatewayIconUrl("")).toBeNull();
    expect(customGatewayIconUrl("javascript:alert(1)")).toBeNull();
    expect(customGatewayIconUrl("<html><body/></html>")).toBeNull();
  });

  it("says the currency code where the operator wrote no line", () => {
    expect(gatewayCaption({ currency: "RUB" })).toBe("RUB");
    expect(gatewayCaption({ currency: "RUB", displayDescription: "  " })).toBe("RUB");
    expect(gatewayCaption({ currency: "RUB", displayDescription: "Карта" })).toBe("Карта");
  });

  it("draws the operator's icon in place of the provider's, and the provider's without one", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <>
          <GatewayIcon type="WATA" currency="RUB" iconSvg={ICON} />
          <GatewayIcon type="WATA" currency="RUB" />
        </>,
      );
    });
    const [custom, provider] = Array.from(container.querySelectorAll("img"));
    expect(custom?.getAttribute("src")).toBe(ICON_URL);
    expect(provider?.getAttribute("src")).not.toBe(ICON_URL);
    expect(provider?.getAttribute("src")).toBeTruthy();
  });
});
