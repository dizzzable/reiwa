// @vitest-environment jsdom

import { act, type ReactNode, type SVGProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop sidebar owns signing out
 * ════════════════════════════════════
 * The control moved out of Settings and into the sidebar on desktop; mobile
 * and the Telegram Mini App keep it in Settings, because neither has a sidebar
 * to move it to (`useIsDesktop` returns false inside a Mini App by design).
 *
 * This file exists because `settings-page.tsx` had NO test before the move, so
 * the refactor had nothing watching it. Two failure modes are cheap to reach
 * and both are quiet:
 *
 *   • the control ends up in BOTH places and the two drift, until the same
 *     action means different things depending on which door was used;
 *   • the desktop branch hides the Settings copy while the sidebar copy is not
 *     reached, leaving that shell with no way out at all.
 *
 * Every presence assertion here is paired with a positive control. A sidebar
 * that rendered nothing at all would otherwise satisfy an "is absent" test
 * perfectly, which is the shape of vacuous guard this repository has been
 * bitten by before.
 */

const Icon = (_props: SVGProps<SVGSVGElement>) => <svg />;
const tabs = [
  { to: "/dashboard", icon: Icon, label: "Subscriptions", testId: "tab-dashboard", matchPrefix: ["/dashboard"] },
];

vi.mock("@/components/layout/use-nav-tabs", () => ({
  useNavTabs: () => tabs,
  resolveActiveTabTo: () => "/dashboard",
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", logoUrl: null, navGap: 2 } }),
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
// The mutation is not under test here — placement is. Stubbed so the sidebar
// can render without a QueryClient, and so a stray render can never fire a
// real sign-out.
vi.mock("@/features/auth/use-sign-out", () => ({
  useSignOut: () => ({ signOut: () => undefined, isPending: false }),
}));

import { SideNav } from "../src/components/layout/side-nav";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function renderSideNav(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <SideNav />
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

describe("sign out on the desktop shell", () => {
  it("is offered in the sidebar, below the destinations", () => {
    const container = renderSideNav();

    // Positive control: the sidebar rendered its normal contents, so what
    // follows is an assertion about placement and not about an empty tree.
    expect(container.querySelector('[data-testid="side-tab-dashboard"]')).not.toBeNull();

    const control = container.querySelector('[data-testid="side-sign-out"]');
    expect(control).not.toBeNull();
    // Below, not among: the footer is a sibling of the destination list, so a
    // regression that drops it into the list would still find the element.
    const list = container.querySelector("ul");
    expect(list?.contains(control ?? null)).toBe(false);
  });

  it("does not open the confirmation until the control is pressed", () => {
    const container = renderSideNav();

    // A sidebar item sits one stray click away from every navigation target,
    // and this one ends a session. The dialog is what makes that recoverable.
    expect(container.textContent).not.toContain("settings.signOutConfirm");
  });

  it("takes its colour from a named token, never a raw palette value", () => {
    const container = renderSideNav();
    const className = container
      .querySelector('[data-testid="side-sign-out"]')
      ?.getAttribute("class") ?? "";

    // The control this replaced used `text-red-400`: no name a theme can
    // override, and no contrast guarantee on a light ground.
    expect(className).toContain("--color-destructive");
    expect(className).not.toMatch(/\bred-\d{3}\b/);
  });
});
