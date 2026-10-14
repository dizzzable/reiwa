// @vitest-environment jsdom

/**
 * Linking an e-mail from the Mini App gives a Telegram customer a `WebAccount`
 * for the first time - a shell, with no login. The cabinet's credential gates
 * look at exactly that field, so the question is whether the customer who did
 * something as small as confirm an address is now thrown at `/finish-setup`.
 *
 * They are not. Under the default policy a Telegram customer is never gated
 * (`skipCredentialSetup`), shell or no shell; the gates stay what they were for
 * everyone the operator or the sign-in method already required credentials of.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
/** Every `<Navigate to=...>` the layout renders, in order. */
const redirects = vi.hoisted(() => [] as string[]);
/** Rendered when the layout lets the route through. */
const outletRendered = vi.hoisted(() => ({ count: 0 }));
const sessionState = vi.hoisted(() => ({
  session: null as unknown,
  isLoading: false,
  isAuthenticated: true,
}));
const location = vi.hoisted(() => ({ pathname: "/settings/privacy", search: "" }));
const platformPolicy = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn(async () => false) }));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => sessionState,
}));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ branding: {} }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => platformPolicy,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { readonly to: string }) => {
    redirects.push(to);
    return null;
  },
  Outlet: () => {
    outletRendered.count += 1;
    return null;
  },
  useLocation: () => location,
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/layout/bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("@/components/layout/side-nav", () => ({ SideNav: () => null }));
vi.mock("@/components/layout/app-background", () => ({ AppBackground: () => null }));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/components/ui/brand-logo", () => ({ BrandLogo: () => null }));
vi.mock("@/components/layout/page-transition", () => ({
  PageTransition: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/hints/hint-controller", () => ({ HintController: () => null }));
vi.mock("@/lib/operator-time-zone-provider", () => ({
  OperatorTimeZoneProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/hooks/use-app-badge", () => ({ useAppBadge: () => undefined }));
vi.mock("@/lib/sw-navigate", () => ({ useServiceWorkerNavigate: () => undefined }));
vi.mock("@/components/policy-wait-note", () => ({ PolicyWaitNote: () => null }));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));

import StealthLayout from "@/components/layout/stealth-layout";

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

const SHELL = { id: "w1", login: null, email: "me@example.com", emailVerifiedAt: "2026-10-01T00:00:00.000Z", requiresPasswordChange: false };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  redirects.length = 0;
  outletRendered.count = 0;
  sessionState.isLoading = false;
  sessionState.isAuthenticated = true;
  platformPolicy.data = { requireTelegramWebCredentials: false };
  api.reportSurface.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("StealthLayout with the shell account that linking an e-mail leaves", () => {
  it("lets a Telegram customer through under the default policy - no /claim, no /finish-setup", () => {
    sessionState.session = { id: "u1", telegramId: "42", webAccount: SHELL };

    mount();

    expect(redirects, "linking an e-mail must not start forcing credentials on a Telegram customer").toEqual([]);
    expect(outletRendered.count).toBeGreaterThan(0);
  });

  it("treats the customer exactly as before they linked anything", () => {
    sessionState.session = { id: "u1", telegramId: "42", webAccount: null };

    mount();

    expect(redirects).toEqual([]);
    expect(outletRendered.count).toBeGreaterThan(0);
  });

  it("waits for the policy rather than guessing, and redirects nowhere meanwhile", () => {
    platformPolicy.data = undefined;
    sessionState.session = { id: "u1", telegramId: "42", webAccount: SHELL };

    mount();

    expect(redirects).toEqual([]);
    expect(outletRendered.count).toBe(0);
  });

  it("still gates a social sign-up that has no Telegram, as it always did", () => {
    sessionState.session = { id: "u2", telegramId: null, webAccount: SHELL };

    mount();

    expect(redirects).toEqual(["/finish-setup?next=%2Fsettings%2Fprivacy"]);
  });

  it("still gates a Telegram customer when the operator requires web credentials, as it always did", () => {
    platformPolicy.data = { requireTelegramWebCredentials: true };
    sessionState.session = { id: "u1", telegramId: "42", webAccount: SHELL };

    mount();

    expect(redirects).toEqual(["/finish-setup?next=%2Fsettings%2Fprivacy"]);
  });
});
