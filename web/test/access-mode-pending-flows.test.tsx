// @vitest-environment jsdom

/**
 * The purchase flows wait for an unknown access mode instead of opening.
 *
 * Buying, upgrading and adding options are gated on the operator's access mode
 * (`PURCHASE_BLOCKED`, `RESTRICTED`). With the policy not known — the first
 * read, or reads failing while the panel is down — `useAccessMode` reports
 * `isLoading` and no flag (never `PUBLIC`, the owner's rule of 24.09.2026). A
 * flow that read "no flag" as "allowed" would open the checkout on an unknown
 * policy; one that read it as "blocked" would tell the customer purchases are
 * off when nobody said so. So each flow waits, like any load.
 *
 * Non-vacuity: the same pages, with the policy known, show the blocked screen
 * or the flow — so the spinner below is the unknown policy's doing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = () => new Promise<never>(() => undefined);
const api = vi.hoisted(() => ({
  getActionPolicy: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getQuote: vi.fn(),
  getEnabledGateways: vi.fn(),
  getPaymentMethods: vi.fn(),
  getPartnerInfo: vi.fn(),
  getUpgradeOptions: vi.fn(),
  getPlans: vi.fn(),
  getAddOnCatalog: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
const access = vi.hoisted(() => ({
  state: { mode: null, known: false, isLoading: true, purchasesBlocked: false, restricted: false, registrationBlocked: false, inviteOnly: false } as Record<string, unknown>,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: new Proxy({}, { get: () => ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> }),
}));
vi.mock("@/lib/use-access-mode", () => ({ useAccessMode: () => access.state }));

import { AccessModeBanner } from "../src/components/access-mode-banner";
import AddOnsPage from "../src/features/addons/addons-page";
import PurchasePage from "../src/features/purchase/purchase-page";
import UpgradePage from "../src/features/upgrade/upgrade-page";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {element}
      </QueryClientProvider>,
    );
  });
}

const UNKNOWN = { mode: null, known: false, isLoading: true, purchasesBlocked: false, restricted: false, registrationBlocked: false, inviteOnly: false };
const BLOCKED = { mode: "PURCHASE_BLOCKED", known: true, isLoading: false, purchasesBlocked: true, restricted: false, registrationBlocked: false, inviteOnly: false };
const OPEN = { mode: "PUBLIC", known: true, isLoading: false, purchasesBlocked: false, restricted: false, registrationBlocked: false, inviteOnly: false };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const fn of Object.values(api)) fn.mockImplementation(pending);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const pendingScreen = () => container?.querySelector('[data-testid="access-mode-pending"]') ?? null;

describe.each([
  ["the purchase wizard", () => <PurchasePage />],
  ["the upgrade wizard", () => <UpgradePage />],
  ["the add-on wizard", () => <AddOnsPage />],
])("%s", (_label, page) => {
  it("waits while the access mode is not known — neither open nor blocked", () => {
    access.state = UNKNOWN;
    mount(page());
    expect(pendingScreen()).not.toBeNull();
    expect(container?.textContent).toBe("");
  });

  it("shows the blocked screen once the mode is known to block", () => {
    access.state = BLOCKED;
    mount(page());
    expect(pendingScreen()).toBeNull();
    expect(container?.textContent).toContain("common.back");
  });

  it("does not wait once the mode is known to allow it", () => {
    access.state = OPEN;
    mount(page());
    expect(pendingScreen()).toBeNull();
  });
});

describe("the access-mode banner", () => {
  it("names nothing while the mode is unknown", () => {
    access.state = UNKNOWN;
    mount(<AccessModeBanner modes={["PURCHASE_BLOCKED", "RESTRICTED", "REG_BLOCKED", "INVITED"]} />);
    expect(container?.innerHTML).toBe("");
  });

  it("names a known restrictive mode", () => {
    access.state = BLOCKED;
    mount(<AccessModeBanner modes={["PURCHASE_BLOCKED"]} />);
    expect(container?.textContent).toContain("accessMode.banner.PURCHASE_BLOCKED.title");
  });
});
