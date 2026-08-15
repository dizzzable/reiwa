// @vitest-environment jsdom

/**
 * WHICH BACKGROUND THE CABINET SHELL ACTUALLY MOUNTS, per configured kind.
 *
 * `StealthLayout` has always chosen between two renderers, and the choice — not
 * `<AppBackground>` alone — is what an operator sees. `<NetworkBg>` (brand
 * glows, dot grid, diagonals) for `none`; `<AppBackground>` for everything
 * else. The panel called `none` "None" and promised a plain colour, so the mode
 * an operator picks to turn the background OFF was the one mode nobody had a
 * test for, in either repository.
 *
 * Two promises are pinned here and they pull in opposite directions:
 *
 *   1. NOTHING CHANGES FOR ANYONE. `none`, an absent block, and a kind from a
 *      future panel all still land on `<NetworkBg>`. Every live installation
 *      stores one of the first two.
 *   2. `plain` REALLY IS PLAIN. It reaches `<AppBackground>`, which paints
 *      nothing — so the shell's own `bg-(--brand-bg-primary)` is all that
 *      shows. That is the mode the old wording described.
 *
 * The two components are mocked to identifiable markers on purpose: this file
 * is about the choice. What `<NetworkBg>` draws is fixed by
 * `network-bg-no-filters.test.tsx`, and what `<AppBackground>` draws by
 * `app-background.test.tsx`; the last case here reaches for the real
 * `<AppBackground>` because "renders nothing" is a claim about it, not about
 * the choice.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBackground as AppBackgroundSettings, Branding } from "../src/types/branding";

const brandingState = vi.hoisted(() => ({ branding: {} as Partial<Branding> }));

vi.mock("@/lib/api-client", () => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn() }));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({
    session: { userId: "u1", telegramId: "42", webAccount: { login: "u1" } },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
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
  Outlet: () => null,
  useLocation: () => ({ pathname: "/dashboard", search: "" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/layout/bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("@/components/layout/side-nav", () => ({ SideNav: () => null }));
vi.mock("@/components/layout/page-transition", () => ({
  PageTransition: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/network-bg", () => ({
  NetworkBg: () => <div data-testid="network-bg" />,
}));
vi.mock("@/components/layout/app-background", () => ({
  AppBackground: () => <div data-testid="app-background" />,
}));

import StealthLayout from "@/components/layout/stealth-layout";
import { DEFAULT_BRANDING } from "@/types/branding";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountWith(appBackground: Partial<AppBackgroundSettings> | undefined): void {
  brandingState.branding = {
    ...DEFAULT_BRANDING,
    appBackground:
      appBackground === undefined
        ? undefined
        : { ...DEFAULT_BRANDING.appBackground!, ...appBackground },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StealthLayout />);
  });
}

/** Which renderer the shell mounted. */
function mounted(): "network-bg" | "app-background" | "neither" {
  if (container?.querySelector('[data-testid="network-bg"]')) return "network-bg";
  if (container?.querySelector('[data-testid="app-background"]')) return "app-background";
  return "neither";
}

beforeEach(() => {
  brandingState.branding = {};
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("app background kind → cabinet shell renderer", () => {
  it("draws the built-in NetworkBg for the stored `none`", () => {
    mountWith({ kind: "none" });

    expect(mounted()).toBe("network-bg");
  });

  it("draws the built-in NetworkBg when branding carries no appBackground at all", () => {
    mountWith(undefined);

    expect(mounted()).toBe("network-bg");
  });

  it("falls back to the built-in NetworkBg for a kind from a future panel", () => {
    // The compatibility promise made in the snapshot guard, seen from the
    // rendering end: an unknown kind is drawn as the familiar default rather
    // than as an empty shell.
    mountWith({ kind: "kindFromAFuturePanelRelease" });

    expect(mounted()).toBe("network-bg");
  });

  it.each(["plain", "gradient", "texture", "effect"] as const)(
    "hands `%s` to AppBackground instead",
    (kind) => {
      mountWith({ kind });

      expect(mounted()).toBe("app-background");
    },
  );

  it("never draws both at once", () => {
    // One WebGL context, one background. A shell that mounted the ambient
    // pattern behind a configured one would double the cost and the picture.
    for (const kind of ["none", "plain", "gradient", "texture", "effect", "?"]) {
      mountWith({ kind });
      const both =
        container?.querySelector('[data-testid="network-bg"]') !== null &&
        container?.querySelector('[data-testid="app-background"]') !== null;
      expect(both).toBe(false);
      act(() => {
        root?.unmount();
      });
      container?.remove();
    }
  });
});
