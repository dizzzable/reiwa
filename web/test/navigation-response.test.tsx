// @vitest-environment jsdom

import { act, type ComponentType, type ReactNode, type SVGProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const Icon = (_props: SVGProps<SVGSVGElement>) => <svg />;
const tabs = [
  { to: "/dashboard", icon: Icon, label: "Subscriptions", testId: "tab-dashboard", matchPrefix: ["/dashboard"] },
  { to: "/settings", icon: Icon, label: "Settings", testId: "tab-settings", matchPrefix: ["/settings"] },
];

vi.mock("@/components/layout/use-nav-tabs", () => ({
  useNavTabs: () => tabs,
  resolveActiveTabTo: (_tabs: typeof tabs, pathname: string) =>
    pathname.startsWith("/settings") ? "/settings" : "/dashboard",
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    branding: { brandName: "Reiwa", logoUrl: null, navGap: 2 },
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  domMax: {},
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: {
    span: ({ layoutId: _layoutId, transition: _transition, ...props }: Record<string, unknown>) => (
      <span {...props} />
    ),
  },
}));

// `SideNav` gained a sign-out control, and with it a `useMutation` —
// rendering it now needs a QueryClient. This file is about which route a tab
// commits, so the mutation is stubbed rather than a provider added: a real
// one would let a stray render fire an actual sign-out request, and the
// placement of the control is covered by `sign-out-placement.test.tsx`.
vi.mock("@/features/auth/use-sign-out", () => ({
  useSignOut: () => ({ signOut: () => undefined, isPending: false }),
}));

import { BottomNav } from "../src/components/layout/bottom-nav";
import { SideNav } from "../src/components/layout/side-nav";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function LocationProbe() {
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}

function renderNavigation(Navigation: ComponentType) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Navigation />
        <LocationProbe />
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});

describe.each([
  ["bottom", BottomNav, '[data-testid="tab-settings"]'],
  ["side", SideNav, '[data-testid="side-tab-settings"]'],
] as const)("%s navigation response", (_name, Navigation, selector) => {
  it("commits the destination in the click turn", () => {
    const container = renderNavigation(Navigation);
    const target = container.querySelector<HTMLElement>(selector);

    act(() => target?.click());

    expect(
      container.querySelector('[data-testid="pathname"]')?.textContent,
    ).toBe("/settings");
    expect(target?.getAttribute("aria-current")).toBe("page");
  });
});
