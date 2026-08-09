// @vitest-environment jsdom

/**
 * A Mini App deep-link must survive the credential gates, not just the auth
 * hand-off.
 *
 * The bot's expiry notification opens `${miniAppUrl}/renew`. `StealthLayout`
 * built `?next=%2Frenew` for its cookieless redirect to `/bootstrap` — and then
 * handed it to nothing else: `<Navigate to="/claim" replace />`,
 * `to="/finish-setup"`, `to="/change-password"`. A first-time Telegram user is
 * routed through exactly one of those (they authenticate into a WebSession with
 * no `WebAccount`), and `/claim` finished on `/dashboard`.
 *
 * So the subscriber taps «Продлить», authenticates, picks a login — and lands on
 * the dashboard. The destination is not recoverable at that point: the launch is
 * spent and the notification is not coming again.
 *
 * The `next` carried through is validated exactly as `tma-bootstrap-page`
 * already validated it — a same-origin absolute path, nothing else — so this
 * cannot widen what a crafted value does. The last case in each group holds that
 * end.
 */

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
  claimAccount: vi.fn(),
  linkExistingAccount: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
/** Every `<Navigate to=…>` the layout renders, in order. */
const redirects = vi.hoisted(() => [] as string[]);
const sessionState = vi.hoisted(() => ({
  session: { userId: "u1", telegramId: "42", webAccount: null } as unknown,
  isLoading: false,
  isAuthenticated: true,
}));
const location = vi.hoisted(() => ({ pathname: "/renew", search: "" }));
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));
/**
 * `/platform-policy`, as `useQuery` would resolve it.
 *
 * The credential gates are reachable for a Telegram-authenticated user only when
 * the operator has turned the extra web-login requirement ON —
 * `skipCredentialSetup` is otherwise true and the user goes straight through.
 * That flag's DEFAULT is not what this file is about and is not touched: it is
 * set explicitly per case, and the last group covers the off-origin end.
 */
const platformPolicy = vi.hoisted(() => ({
  data: { requireTelegramWebCredentials: true } as unknown,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn() }));
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
  useQueryClient: () => queryClient,
}));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { readonly to: string }) => {
    redirects.push(to);
    return null;
  },
  Outlet: () => null,
  useLocation: () => location,
  useNavigate: () => navigate,
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
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/lib/crypto", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));
vi.mock("lucide-react", () => ({
  ShieldCheck: () => null,
  Eye: () => null,
  EyeOff: () => null,
  Loader2: () => null,
}));
vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        ({ children, onSubmit, noValidate }: {
          readonly children?: ReactNode;
          readonly onSubmit?: (event: React.FormEvent) => void;
          readonly noValidate?: boolean;
        }) => {
          const Tag = tag as "div";
          return (
            <Tag {...(tag === "form" ? { onSubmit, noValidate } : {})}>{children}</Tag>
          );
        },
    },
  ),
}));

import StealthLayout from "@/components/layout/stealth-layout";
import ClaimPage from "@/features/auth/claim-page";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

/** Sets a controlled input's value the way a real keystroke would. */
function type(selector: string, value: string): void {
  const input = container?.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input matching ${selector}`);
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const form = container?.querySelector("form");
  if (!form) throw new Error("no form rendered");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/renew");
  window.location.hash = "";
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  redirects.length = 0;
  location.pathname = "/renew";
  location.search = "";
  sessionState.session = { userId: "u1", telegramId: "42", webAccount: null };
  sessionState.isLoading = false;
  sessionState.isAuthenticated = true;
  platformPolicy.data = { requireTelegramWebCredentials: true };
  api.reportSurface.mockResolvedValue({ ok: true });
  api.claimAccount.mockResolvedValue({ userId: "u1", webAccountId: "w1" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("StealthLayout carries the deep-link destination into the credential gates", () => {
  it("attaches it to the claim gate", () => {
    // Authenticated, no WebAccount: the mandatory claim gate. This is the exact
    // state a first-time Telegram user reaches after tapping «Продлить».
    mount(<StealthLayout />);

    expect(
      redirects,
      "the claim gate dropped the deep-link destination — the subscriber finishes the form and lands on /dashboard, with /renew unreachable and the notification spent",
    ).toEqual(["/claim?next=%2Frenew"]);
  });

  it("attaches it to the finish-setup gate", () => {
    sessionState.session = {
      userId: "u1",
      telegramId: "42",
      webAccount: { login: "", requiresPasswordChange: false },
    };

    mount(<StealthLayout />);

    expect(redirects).toEqual(["/finish-setup?next=%2Frenew"]);
  });

  it("attaches it to the forced password change", () => {
    sessionState.session = {
      userId: "u1",
      telegramId: "42",
      webAccount: { login: "existing", requiresPasswordChange: true },
    };

    mount(<StealthLayout />);

    expect(redirects).toEqual(["/change-password?next=%2Frenew"]);
  });

  it("still attaches it to the cookieless bootstrap redirect", () => {
    sessionState.session = null;

    mount(<StealthLayout />);

    expect(redirects).toEqual(["/bootstrap?next=%2Frenew"]);
  });

  it("adds nothing for the default destinations", () => {
    // `/` and `/dashboard` ARE the fallback, so a `next` pointing at them is
    // noise in the URL and one more thing to get wrong.
    location.pathname = "/dashboard";

    mount(<StealthLayout />);

    expect(redirects).toEqual(["/claim"]);
  });
});

describe("the claim gate honours the destination it was given", () => {
  it("lands the user on the deep-link page after the claim succeeds", async () => {
    window.history.replaceState({}, "", "/claim?next=%2Frenew");

    mount(<ClaimPage />);
    type("#claim-username", "new-user");
    type("#claim-password", "correct horse battery");
    await submit();

    expect(api.claimAccount).toHaveBeenCalledWith("new-user", "hashed-password");
    expect(
      navigate,
      "the claim finished on /dashboard — the deep-link the user tapped is spent and /renew is only reachable if they go looking for it",
    ).toHaveBeenCalledWith("/renew", { replace: true });
  });

  it("sends an already-claimed user straight to the deep-link page", async () => {
    window.history.replaceState({}, "", "/claim?next=%2Frenew");
    sessionState.session = {
      userId: "u1",
      telegramId: "42",
      webAccount: { login: "existing", requiresPasswordChange: false },
    };

    mount(<ClaimPage />);

    expect(navigate).toHaveBeenCalledWith("/renew", { replace: true });
  });

  it("refuses an off-origin destination and falls back to the dashboard", async () => {
    // `//evil.example` is a protocol-relative URL that `navigate()` would follow
    // off-app. Carrying `next` further must not widen what a crafted one can do.
    window.history.replaceState({}, "", "/claim?next=%2F%2Fevil.example%2Fphish");

    mount(<ClaimPage />);
    type("#claim-username", "new-user");
    type("#claim-password", "correct horse battery");
    await submit();

    expect(
      navigate,
      "a crafted `next` was honoured — the credential gate now redirects off-origin",
    ).toHaveBeenCalledWith("/dashboard", { replace: true });
  });
});
