// @vitest-environment jsdom

/**
 * WHEN THE SHELL RUNS THE PUSH HEAL, AND HOW MANY TIMES AT ONCE.
 *
 * Two faults of the change that repaired push, both in the same effect.
 *
 * ONCE PER TAB, FOR EVER. The gate was `sessionStorage.getItem(key) === "1"`,
 * and `sessionStorage` outlives reloads and `location.replace`. A tab that
 * healed at nine in the morning would not try again — not after the worker
 * rotated the subscription into a lapsed session and was refused, not after a
 * server-side prune. Push stayed dead in that tab for as long as it lived.
 *
 * TWICE AT ONCE. The effect depends on `session`, whose object identity changes
 * whenever the `["session"]` query is invalidated — `subscription.created`,
 * `payment.completed`, `referral.reward_issued`, and a purchase fires more than
 * one within seconds. Since the marker is only written on SUCCESS, nothing
 * stopped a second run starting while the first was still in flight: two
 * `subscribe()` calls and two POSTs against the per-IP budget every customer
 * behind one NAT shares.
 *
 * Driven through the real shell, because both are properties of the effect's
 * scheduling and neither is legible in the source of the function it calls.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
const push = vi.hoisted(() => ({ ensurePushSubscription: vi.fn() }));
const sessionState = vi.hoisted(() => ({
  session: { userId: "u1", telegramId: "42" } as unknown,
  isLoading: false,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => push);
vi.mock("@/hooks/use-session", () => ({ useSession: () => sessionState }));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ branding: {} }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("react-router", () => ({
  Navigate: () => null,
  Outlet: () => null,
  useLocation: () => ({ pathname: "/dashboard", search: "" }),
  useNavigate: () => () => undefined,
}));
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
vi.mock("@/features/hints/hint-controller", () => ({ HintController: () => null }));

import StealthLayout from "@/components/layout/stealth-layout";
import { PUSH_RESYNC_KEY, PUSH_RESYNC_MAX_AGE_MS } from "@/lib/push-resync-marker";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StealthLayout />);
  });
}

/** What the cabinet does when the `["session"]` query is invalidated. */
function sessionInvalidated(): void {
  sessionState.session = { userId: "u1", telegramId: "42" };
  act(() => {
    root?.render(<StealthLayout />);
  });
}

const markerAt = (at: number): void => {
  sessionStorage.setItem(PUSH_RESYNC_KEY, JSON.stringify({ at }));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/dashboard");
  sessionStorage.clear();
  sessionState.session = { userId: "u1", telegramId: "42" };
  push.ensurePushSubscription.mockResolvedValue(true);
  api.reportSurface.mockResolvedValue({ ok: true });
  api.getPlatformPolicy.mockResolvedValue({});
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the shell's push heal", () => {
  it("runs when nothing has healed this tab yet", async () => {
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(push.ensurePushSubscription).toHaveBeenCalledTimes(1);
  });

  it("does not run again straight after one that landed", async () => {
    // The cheapness that makes the marker worth having at all: an ordinary
    // visit, with its several session invalidations, heals once.
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    sessionInvalidated();
    await act(async () => {
      await Promise.resolve();
    });

    expect(push.ensurePushSubscription).toHaveBeenCalledTimes(1);
  });

  it("runs again once the marker from an earlier heal has gone stale", async () => {
    // The pinned tab. Something broke push between that heal and now — a
    // refused re-registration, a server-side prune — and nothing in this tab
    // would ever have tried again.
    markerAt(Date.now() - PUSH_RESYNC_MAX_AGE_MS - 1);

    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      push.ensurePushSubscription,
      "a tab that healed hours ago will not heal again, so push stays dead in it until the customer closes the tab",
    ).toHaveBeenCalledTimes(1);
  });

  it("runs when the worker retracted the marker after a refused re-registration", async () => {
    // What the worker's `PUSH_RESYNC_FAILED` message does to the page. The
    // marker is gone, so the next session change heals rather than the tab
    // believing itself done.
    markerAt(Date.now());
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(push.ensurePushSubscription).not.toHaveBeenCalled();

    sessionStorage.removeItem(PUSH_RESYNC_KEY);
    sessionInvalidated();
    await act(async () => {
      await Promise.resolve();
    });

    expect(push.ensurePushSubscription).toHaveBeenCalledTimes(1);
  });

  it("retries on the next session change when a heal did not land", async () => {
    // A 429 from the shared per-IP budget, a 503 while the BFF has no upstream.
    // Nothing is marked, so the next invalidation tries again.
    push.ensurePushSubscription.mockResolvedValue(false);

    mount();
    await act(async () => {
      await Promise.resolve();
    });
    sessionInvalidated();
    await act(async () => {
      await Promise.resolve();
    });

    expect(push.ensurePushSubscription).toHaveBeenCalledTimes(2);
  });

  it("does not start a second heal while the first is still in flight", async () => {
    // A purchase invalidates `["session"]` more than once within seconds, and
    // the marker cannot help here — it is only written when the heal LANDS.
    let release: (value: boolean) => void = () => undefined;
    push.ensurePushSubscription.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );

    mount();
    sessionInvalidated();
    sessionInvalidated();

    expect(
      push.ensurePushSubscription,
      "two heals ran together: two subscribe calls and two POSTs against a budget every customer behind one NAT shares",
    ).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(true);
      await Promise.resolve();
    });
  });
});
