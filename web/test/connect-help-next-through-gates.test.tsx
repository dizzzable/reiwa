// @vitest-environment jsdom

/**
 * The connect-help deep link survives the way into the cabinet.
 *
 * `/dashboard?connect=help[&subscriptionId=…]` is where the push, the bot's
 * «📲 Подключить» and the pop-up land. For somebody not signed in — a Mini App
 * opened without the cabinet's cookie, the bot's button opened in a browser —
 * the protected shell redirects first, and it used to build its `?next=` for
 * every page EXCEPT `/` and `/dashboard`. So the link was dropped at the door:
 * after signing in the customer met a plain dashboard, the card the help was
 * about unnamed and the connect door never opened.
 *
 * The rule now: `/dashboard` still gets no `next` of its own — it is where
 * every sign-in ends anyway — unless it carries the deep link, which is then
 * REBUILT from its two parameters and validated like every other `next`.
 *
 * The shell is real; its neighbours are stubbed the way
 * `deep-link-next-through-gates.test.tsx` stubs them.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  reportSurface: vi.fn(async () => ({ ok: true })),
  getPlatformPolicy: vi.fn(),
}));
/** Every `<Navigate to=…>` the layout renders, in order. */
const redirects = vi.hoisted(() => [] as string[]);
const sessionState = vi.hoisted(() => ({
  session: null as unknown,
  isLoading: false,
  isAuthenticated: false,
}));
const location = vi.hoisted(() => ({ pathname: "/dashboard", search: "" }));
const platformPolicy = vi.hoisted(() => ({ data: { requireTelegramWebCredentials: true } as unknown }));

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
vi.mock("@tanstack/react-query", () => ({ useQuery: () => platformPolicy }));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { readonly to: string }) => {
    redirects.push(to);
    return null;
  },
  Outlet: () => null,
  useLocation: () => location,
  useNavigate: () => () => undefined,
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
import { sanitizeNextDestination } from "@/lib/next-destination";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Opens the shell at `address` and hands back the one redirect it rendered. */
function openAt(address: string): string {
  const question = address.indexOf("?");
  location.pathname = question === -1 ? address : address.slice(0, question);
  location.search = question === -1 ? "" : address.slice(question);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StealthLayout />);
  });
  expect(redirects, `the shell rendered ${redirects.length} redirects for ${address}`).toHaveLength(1);
  return redirects[0] as string;
}

/** The `next` a redirect carries, decoded — or `null` when it carries none. */
function nextOf(redirect: string): string | null {
  const question = redirect.indexOf("?");
  return question === -1 ? null : new URLSearchParams(redirect.slice(question)).get("next");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  redirects.length = 0;
  sessionState.session = null;
  sessionState.isLoading = false;
  platformPolicy.data = { requireTelegramWebCredentials: true };
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the cookieless redirect keeps the connect-help deep link", () => {
  it("carries the link with the subscription it names", () => {
    const redirect = openAt("/dashboard?connect=help&subscriptionId=cmsub0001abcdefghijklmno");

    expect(
      redirect,
      "the deep link was dropped at the door — after signing in the customer lands on a plain dashboard",
    ).toBe("/bootstrap?next=%2Fdashboard%3Fconnect%3Dhelp%26subscriptionId%3Dcmsub0001abcdefghijklmno");
  });

  it("carries the link that names no subscription", () => {
    expect(nextOf(openAt("/dashboard?connect=help"))).toBe("/dashboard?connect=help");
  });

  it("is a same-origin path, as every hop downstream requires", () => {
    const next = nextOf(openAt("/dashboard?connect=help&subscriptionId=cmsub0001abcdefghijklmno"));

    expect(next).not.toBeNull();
    expect(sanitizeNextDestination(next), "a hop downstream would refuse this next").toBe(next);
  });

  it("names the page and nothing else the address carried", () => {
    // Rebuilt, not copied: an ad's tags ride the bootstrap hop on their own, and
    // a `next` smuggled into the link is not relayed inside this one.
    const next = nextOf(
      openAt("/dashboard?utm_source=bot&connect=help&subscriptionId=cm1&next=%2F%2Fevil.example%2Fphish"),
    );

    expect(next).toBe("/dashboard?connect=help&subscriptionId=cm1");
  });

  it("drops an id that could reshape an address, and still keeps the link", () => {
    expect(nextOf(openAt("/dashboard?connect=help&subscriptionId=..%2F..%2Fdevices"))).toBe(
      "/dashboard?connect=help",
    );
  });
});

describe("the credential gates keep it too", () => {
  const LINK = "/dashboard?connect=help&subscriptionId=cm1";
  const ENCODED = "?next=%2Fdashboard%3Fconnect%3Dhelp%26subscriptionId%3Dcm1";

  it("through the claim gate", () => {
    sessionState.session = { userId: "u1", telegramId: "42", webAccount: null };
    expect(openAt(LINK)).toBe(`/claim${ENCODED}`);
  });

  it("through the finish-setup gate", () => {
    sessionState.session = { userId: "u1", telegramId: "42", webAccount: { login: "", requiresPasswordChange: false } };
    expect(openAt(LINK)).toBe(`/finish-setup${ENCODED}`);
  });

  it("through the forced password change", () => {
    sessionState.session = {
      userId: "u1",
      telegramId: "42",
      webAccount: { login: "existing", requiresPasswordChange: true },
    };
    expect(openAt(LINK)).toBe(`/change-password${ENCODED}`);
  });
});

describe("everything else is as it was", () => {
  it("a plain dashboard carries no next", () => {
    expect(openAt("/dashboard")).toBe("/bootstrap");
  });

  it("a dashboard with other parameters carries no next either", () => {
    expect(openAt("/dashboard?utm_source=bot&connect=other")).toBe("/bootstrap");
  });

  it("any other page carries its full address, query included", () => {
    expect(openAt("/renew?subscriptionId=cm1")).toBe("/bootstrap?next=%2Frenew%3FsubscriptionId%3Dcm1");
  });
});
