// @vitest-environment jsdom

/**
 * A ROUTE'S GROUND COVERS THE CONTENT AREA, AND STOPS AT THE NAVIGATION.
 *
 * The connect screen wears a concept the operator picked for it. The palette
 * travelled fine — it is declared on the screen's own element and inherits
 * down — but the GROUND did not: the screen is rendered inside `<main>`'s
 * centred `max-w-[46rem]` column, so a background painted there is a themed
 * rectangle floating in the cabinet's own black with a visible seam down each
 * side. Reported from a desktop as "что за обрубки по бокам", together with the
 * rule this file exists to hold: the page is painted, the sidebar is not.
 *
 * Both halves are structural, and both are easy to lose:
 *
 *   1. The ground lands on `<main>`. Anywhere inside the column and the seams
 *      come back; on the shell around `<main>` and it would run under the
 *      navigation.
 *   2. Nothing about it reaches the navigation. That is true by construction —
 *      `<main>` is a SIBLING of the sidebar and of the floating capsule — and
 *      this checks the construction rather than the intention, because the day
 *      somebody moves the navigation inside `<main>` nothing else will notice.
 *
 * The store is written directly here rather than by rendering the connect
 * screen: the two are deliberately decoupled (a lazily-loaded route publishing
 * upwards to the shell above it), and the screen's own half is covered in
 * `connect-page-composition.test.tsx`.
 */

import { act, type ReactNode, type SVGProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Branding } from "../src/types/branding";

const brandingState = vi.hoisted(() => ({ branding: {} as Partial<Branding> }));
const viewport = vi.hoisted(() => ({ isDesktop: true }));

const Icon = (_props: SVGProps<SVGSVGElement>) => <svg />;

vi.mock("@/lib/api-client", () => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn(async () => false) }));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({
    session: { userId: "u1", telegramId: "42", webAccount: { login: "u1" } },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => viewport.isDesktop }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: brandingState.branding }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { requireTelegramWebCredentials: false } }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { readonly to: string }) => <span data-redirect={to} />,
  NavLink: ({
    to,
    children,
    ...rest
  }: { readonly to: string; readonly children?: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="route-content" />,
  useLocation: () => ({ pathname: "/subscription/connect", search: "" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  domMax: {},
  LazyMotion: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  m: {
    span: ({ layoutId: _layoutId, transition: _transition, ...props }: Record<string, unknown>) => (
      <span {...props} />
    ),
  },
}));
vi.mock("@/components/layout/use-nav-tabs", () => ({
  useNavTabs: () => [
    { to: "/dashboard", icon: Icon, label: "Подписки", testId: "tab-dashboard", matchPrefix: ["/dashboard"] },
  ],
  resolveActiveTabTo: () => "/dashboard",
}));
// A real element rather than `null`: the point of these cases is WHERE the
// navigation sits relative to `<main>`, and a component that renders nothing
// cannot be anywhere.
vi.mock("@/components/layout/side-nav", () => ({
  SideNav: () => <nav data-testid="side-nav" />,
}));
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => <div data-testid="network-bg" /> }));
vi.mock("@/components/layout/app-background", () => ({ AppBackground: () => null }));

import StealthLayout from "@/components/layout/stealth-layout";
import { usePageBackdropStore } from "@/stores/page-backdrop.store";
import { DEFAULT_BRANDING } from "@/types/branding";

const CONCEPT = {
  backgroundColor: "#05070D",
  backgroundImage: "linear-gradient(145deg, #05070D 0%, #0B0610 100%)",
  rail: "#FF6B7A",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLElement {
  brandingState.branding = { ...DEFAULT_BRANDING };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<StealthLayout />));
  const main = container.querySelector("main");
  if (main === null) throw new Error("the shell rendered no <main>");
  return main;
}

beforeEach(() => {
  viewport.isDesktop = true;
  usePageBackdropStore.setState({ backdrop: null });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  usePageBackdropStore.setState({ backdrop: null });
});

describe("a route that asked for its own ground", () => {
  it("paints the whole content area, not the column inside it", () => {
    usePageBackdropStore.setState({ backdrop: CONCEPT });
    const main = mount();
    expect(main.style.backgroundColor).not.toBe("");
    expect(main.style.backgroundImage).toContain("linear-gradient");
  });

  it("runs the accent rail down the edge of that area", () => {
    usePageBackdropStore.setState({ backdrop: CONCEPT });
    const main = mount();
    const rail = main.querySelector<HTMLElement>("[data-page-rail]");
    expect(rail, "the concept's rail is missing").not.toBeNull();
    // Sticky, not absolute: an absolutely positioned child of a scroll
    // container is laid out against its padding box, so a long page loses the
    // rail below the fold.
    expect(rail?.className).toContain("sticky");
  });

  it("leaves the navigation alone, because the navigation is not inside it", () => {
    // The half of the request that says the sidebar keeps the cabinet's own
    // appearance. It holds by construction, and this is the construction.
    usePageBackdropStore.setState({ backdrop: CONCEPT });
    const main = mount();
    const nav = container?.querySelector("[data-testid='side-nav']");
    expect(nav, "the sidebar did not render").not.toBeNull();
    expect(main.contains(nav!), "the sidebar sits inside the painted area").toBe(false);
  });

  it("paints the capsule's page the same way on a phone", () => {
    viewport.isDesktop = false;
    usePageBackdropStore.setState({ backdrop: CONCEPT });
    const main = mount();
    expect(main.style.backgroundImage).toContain("linear-gradient");
    expect(main.querySelector("[data-page-rail]")).not.toBeNull();
    // And the room kept for the floating navigation survives the merge — the
    // ground is spread into the same style object that carries it.
    expect(main.style.paddingBottom).not.toBe("");
  });
});

describe("every other route", () => {
  it("leaves the content area exactly as it was", () => {
    // Nothing is the ordinary case: one screen in the cabinet publishes a
    // ground and the rest must be untouched by this machinery.
    const main = mount();
    expect(main.style.backgroundColor).toBe("");
    expect(main.style.backgroundImage).toBe("");
    expect(main.querySelector("[data-page-rail]")).toBeNull();
  });
});
