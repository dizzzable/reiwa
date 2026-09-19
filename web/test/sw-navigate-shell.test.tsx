// @vitest-environment jsdom

/**
 * The protected shell routes a push click that lands on an open cabinet.
 *
 * `sw-navigate.test.tsx` proves the listener itself. This proves it is MOUNTED
 * where every push destination renders — the shell — which is the half that
 * nothing else would notice going missing: the hook would stay tested and
 * green, and a push clicked with the cabinet open would once again bring the
 * window forward and leave it where it was.
 *
 * The shell is real; its neighbours are stubbed the way
 * `surface-telemetry-tma.test.tsx` stubs them.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  reportSurface: vi.fn(async () => ({ ok: true })),
  getPlatformPolicy: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  session: {
    userId: "u1",
    telegramId: "42",
    webAccount: { login: "existing-user", requiresPasswordChange: false },
  } as unknown,
  isLoading: false,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn(async () => false) }));
vi.mock("@/hooks/use-session", () => ({ useSession: () => sessionState }));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ branding: {} }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("react-router", () => ({
  Navigate: () => null,
  Outlet: () => null,
  useLocation: () => ({ pathname: "/settings", search: "" }),
  useNavigate: () => navigate,
}));
vi.mock("@/features/hints/hint-controller", () => ({ HintController: () => null }));
vi.mock("@/components/layout/bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("@/components/layout/side-nav", () => ({ SideNav: () => null }));
vi.mock("@/components/layout/app-background", () => ({ AppBackground: () => null }));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/components/layout/page-transition", () => ({
  PageTransition: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));

import StealthLayout from "@/components/layout/stealth-layout";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let worker: EventTarget;

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StealthLayout />);
  });
}

function post(url: string): void {
  act(() => {
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "NAVIGATE", url }, origin: window.location.origin }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  worker = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  sessionState.isLoading = false;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the shell and the service worker's NAVIGATE", () => {
  it("routes the push's destination through the router", () => {
    mount();

    post("/dashboard?connect=help&subscriptionId=cmsub001");

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/dashboard?connect=help&subscriptionId=cmsub001");
  });

  it("listens while the session is still loading, too — the hook sits above every early return", () => {
    sessionState.isLoading = true;
    mount();

    post("/renew");

    expect(navigate).toHaveBeenCalledWith("/renew");
  });

  it("does not route what the worker was not allowed to send", () => {
    mount();

    post("https://evil.example/phish");

    expect(navigate).not.toHaveBeenCalled();
  });
});
