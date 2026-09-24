// @vitest-environment jsdom

/**
 * A platform policy nobody could read is UNKNOWN — never "open to everyone".
 *
 * `/api/v1/platform-policy` answers 503 when the cabinet's API has never known
 * a policy and the panel is down (CD1 §4). The SPA used to read that as the
 * access mode `PUBLIC` (`data?.accessMode ?? "PUBLIC"`), the claim gate off
 * (`requireTelegramWebCredentials ?? false`) and link recovery off — so a
 * first load during an outage opened invite-only registration and let a
 * Telegram user past a claim gate the operator had switched on. The owner's
 * rule of 24.09.2026: never read it as PUBLIC or as any permissive "off".
 *
 * Pinned here, with the real query options (`lib/platform-policy-query.ts`):
 *   - an unreadable policy is `mode: null`, no flag set, `isLoading` true — and
 *     it stays so while reads keep failing, asking again 3 s → 30 s, even on a
 *     page the platform calls hidden; the answer, when it comes, is used;
 *   - once a policy was read, a failing refresh keeps it;
 *   - the shell holds a Telegram user without a finished web login on its
 *     spinner until the policy is known, and only that user.
 */
import { act, useEffect, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPlatformPolicy: vi.fn(),
  reportSurface: vi.fn(),
}));
const redirects = vi.hoisted(() => [] as string[]);
const sessionState = vi.hoisted(() => ({
  session: { userId: "u1", telegramId: "42", webAccount: null } as unknown,
  isLoading: false,
  isAuthenticated: true,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn(async () => false) }));
vi.mock("@/hooks/use-session", () => ({ SESSION_QUERY_KEY: ["session"], useSession: () => sessionState }));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/hooks/use-app-badge", () => ({ useAppBadge: () => undefined }));
vi.mock("@/lib/sw-navigate", () => ({ useServiceWorkerNavigate: () => undefined }));
vi.mock("@/features/hints/hint-controller", () => ({ HintController: () => null }));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ branding: {} }) }));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { readonly to: string }) => {
    redirects.push(to);
    return null;
  },
  Outlet: () => <p data-testid="cabinet">cabinet</p>,
  useLocation: () => ({ pathname: "/dashboard", search: "" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
import { platformPolicyRetryDelay } from "@/lib/platform-policy-query";
import { useAccessMode, useSubscriptionLinkRecovery, type AccessModeState } from "@/lib/use-access-mode";

/** What the BFF's 503 looks like to the SPA: axios rejects. */
const UNAVAILABLE = Object.assign(new Error("Request failed with status code 503"), {
  response: { status: 503, data: { message: "Platform policy unavailable" } },
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let visibility: DocumentVisibilityState = "visible";

function mount(element: ReactElement): QueryClient {
  const client = new QueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  return client;
}

/** Move the clock and let React Query hand its results to React (timers set during a tick land 1 ms out). */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

const seen: { access?: AccessModeState; recovery?: { enabled: boolean; isLoading: boolean } } = {};
function Probe() {
  const access = useAccessMode();
  const recovery = useSubscriptionLinkRecovery();
  useEffect(() => {
    seen.access = access;
    seen.recovery = recovery;
  });
  return null;
}
/**
 * One reader only. Every reader keeps its own interval, and they fire in the
 * same tick; with a response that is INSTANT (a mock, never a network) the
 * first read is over before the second timer runs, so it cannot join it. The
 * cadence is what this probe measures.
 */
function AccessProbe() {
  const access = useAccessMode();
  useEffect(() => {
    seen.access = access;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  redirects.length = 0;
  sessionState.session = { userId: "u1", telegramId: "42", webAccount: null };
  api.reportSurface.mockResolvedValue({ ok: true });
  delete seen.access;
  delete seen.recovery;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("reading an unreadable policy", () => {
  it("is unknown — no mode, no flag, still loading — never PUBLIC", async () => {
    api.getPlatformPolicy.mockRejectedValue(UNAVAILABLE);
    mount(<Probe />);
    await elapse(0);

    expect(api.getPlatformPolicy).toHaveBeenCalledTimes(1);
    expect(seen.access).toEqual({
      mode: null,
      known: false,
      isLoading: true,
      purchasesBlocked: false,
      restricted: false,
      registrationBlocked: false,
      inviteOnly: false,
    });
    // Link recovery waits too, instead of reading the outage as "switched off".
    expect(seen.recovery).toEqual({ enabled: false, isLoading: true });
  });

  it("asks again on its own, 3 s after the failure and doubling to 30 s — hidden page or not", async () => {
    api.getPlatformPolicy.mockRejectedValue(UNAVAILABLE);
    // The platform claims the page is hidden: the retries must not depend on it.
    visibility = "hidden";
    const start = Date.now();
    const askedAt: number[] = [];
    api.getPlatformPolicy.mockImplementation(async () => {
      askedAt.push(Date.now() - start);
      throw UNAVAILABLE;
    });
    mount(<AccessProbe />);
    await elapse(100_000);

    // Each ask a fixed wait after the failure before it: 3 s, then doubling to 30 s.
    expect(askedAt).toEqual([0, 3_000, 9_000, 21_000, 45_000, 75_000]);
    expect(seen.access?.isLoading).toBe(true);
  });

  it("uses the policy the moment one is read, and stops asking", async () => {
    api.getPlatformPolicy
      .mockRejectedValueOnce(UNAVAILABLE)
      .mockResolvedValue({ accessMode: "INVITED", subscriptionLinkRecovery: true });
    mount(<Probe />);
    await elapse(0);
    expect(seen.access?.isLoading).toBe(true);

    await elapse(3_000);
    expect(seen.access).toMatchObject({ mode: "INVITED", known: true, isLoading: false, inviteOnly: true });
    expect(seen.recovery).toEqual({ enabled: true, isLoading: false });

    await elapse(10 * 60_000);
    expect(api.getPlatformPolicy).toHaveBeenCalledTimes(2);
  });

  it("keeps a policy it has read when a later refresh fails", async () => {
    api.getPlatformPolicy.mockResolvedValueOnce({ accessMode: "PURCHASE_BLOCKED" }).mockRejectedValue(UNAVAILABLE);
    const client = mount(<Probe />);
    await elapse(0);
    expect(seen.access?.purchasesBlocked).toBe(true);

    await act(async () => {
      await client.refetchQueries({ queryKey: ["platform-policy"] });
    });
    await elapse(0);
    expect(seen.access).toMatchObject({ mode: "PURCHASE_BLOCKED", known: true, isLoading: false, purchasesBlocked: true });
  });

  it("still reads a policy without the field the way it always did", async () => {
    api.getPlatformPolicy.mockResolvedValue({});
    mount(<Probe />);
    await elapse(0);
    expect(seen.access).toMatchObject({ mode: "PUBLIC", known: true, isLoading: false });
  });

  it("waits 3 s, 6 s, 12 s, 24 s, then 30 s at most", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(platformPolicyRetryDelay)).toEqual([
      3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("the shell’s claim gate with no policy known", () => {
  it("holds a Telegram user without a web login on the spinner — neither the cabinet nor /claim", async () => {
    api.getPlatformPolicy.mockRejectedValue(UNAVAILABLE);
    mount(<StealthLayout />);
    await elapse(0);

    expect(container?.querySelector('[data-testid="shell-loading"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="cabinet"]')).toBeNull();
    expect(redirects).toEqual([]);
  });

  it("sends that user to /claim once the policy says the operator requires it", async () => {
    api.getPlatformPolicy
      .mockRejectedValueOnce(UNAVAILABLE)
      .mockResolvedValue({ accessMode: "PUBLIC", requireTelegramWebCredentials: true });
    mount(<StealthLayout />);
    await elapse(0);
    expect(redirects).toEqual([]);

    await elapse(3_000);
    expect(redirects).toEqual(["/claim"]);
  });

  it("lets that user in once the policy says it does not", async () => {
    api.getPlatformPolicy
      .mockRejectedValueOnce(UNAVAILABLE)
      .mockResolvedValue({ accessMode: "PUBLIC", requireTelegramWebCredentials: false });
    mount(<StealthLayout />);
    await elapse(3_000);

    expect(container?.querySelector('[data-testid="shell-loading"]')).toBeNull();
    expect(container?.querySelector('[data-testid="cabinet"]')).not.toBeNull();
    expect(redirects).toEqual([]);
  });

  it("does not hold anybody whose way in does not depend on the policy", async () => {
    api.getPlatformPolicy.mockRejectedValue(UNAVAILABLE);
    sessionState.session = { userId: "u1", telegramId: "42", webAccount: { login: "anna" } };
    mount(<StealthLayout />);
    await elapse(0);

    expect(container?.querySelector('[data-testid="shell-loading"]')).toBeNull();
    expect(container?.querySelector('[data-testid="cabinet"]')).not.toBeNull();
  });
});
